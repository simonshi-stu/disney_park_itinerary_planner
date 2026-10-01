import { createHash, randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ingestSourceSnapshot } from "../../modules/ingestion/index.mjs";
import { buildSourceHealthRecord, persistSourceHealthRecord } from "../../modules/ingestion/source-health.mjs";
import { createPostgresArchiveLineReferenceRepository } from "../../infra/archive-line-reference-postgres.mjs";
import { createPostgresCatalogRepository } from "../../infra/catalog-postgres.mjs";
import {
  withPostgresStorageTransaction,
  createPostgresNormalizedObservationRepository
} from "../../infra/normalized-observations-postgres.mjs";
import {
  assertCurrentValidationAuthorization,
  calculateDatabaseFingerprint,
  writeNormalizedOnlyHostedSnapshot
} from "../../infra/normalized-only-hosted-write.mjs";
import { createPostgresSourceHealthRepository } from "../../infra/source-health-postgres.mjs";
import { DualWriteError, dualWriteFeatureFlag, isDualWriteEnabled, runDualWrite } from "./dual-write.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const snapshotCsvHeader = [
  "snapshot_utc",
  "snapshot_park_datetime",
  "snapshot_park_date",
  "snapshot_timezone",
  "park_id",
  "park_name",
  "land",
  "ride_id",
  "ride_name",
  "is_open",
  "wait_time_minutes",
  "source_last_updated_utc",
  "source_last_updated_park_datetime",
  "source_url"
];

export function serializeSnapshotRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("latest snapshot contains no rows");
  return `${[
    snapshotCsvHeader.join(","),
    ...rows.map((row) => snapshotCsvHeader.map((key) => csvEscape(row[key])).join(","))
  ].join("\n")}\n`;
}

export async function runBootstrapDualWrite(options = {}) {
  const rootDir = options.rootDir || root;
  const environment = options.environment || process.env;
  if (environment.COLLECTOR_RUN_OUTCOME === "failure") {
    return runBootstrapSourceFailure(options);
  }
  const enabled = isDualWriteEnabled(options.enabled ?? environment.COLLECTOR_DUAL_WRITE_ENABLED);
  const input = await loadLatestSnapshot(rootDir);
  const envelope = await buildSourceEnvelope(input, options.clock);
  const writeGitFallback = async () => {
    if (environment.COLLECTOR_GIT_FALLBACK_OUTCOME === "failure") {
      throw new Error("Git fallback commit failed before hosted persistence was attempted");
    }
    await access(input.csvPath);
  };
  const hosted = enabled ? createNormalizedOnlyHostedWriter({ input, environment, options }) : null;
  const writeHosted = hosted ? hosted.writeHosted : undefined;
  let result;
  try {
    result = await runDualWrite({
      envelope,
      enabled,
      runId: environment.COLLECTOR_RUN_ID || undefined,
      clock: options.clock,
      writeGitFallback,
      writeHosted
    });
  } catch (error) {
    if (!(error instanceof DualWriteError)) throw error;
    const databaseFallback = await resolveDatabaseFallbackGate({ hosted, environment, options });
    const sourceHealth = await persistSourceHealthForRun({
      envelope,
      result: error.result,
      recordCount: input.latest.rows.length,
      environment,
      repository: options.sourceHealthRepository,
      clock: options.clock,
      allowDatabaseFallback: enabled,
      databaseFallback,
      createSourceHealthPool: options.createSourceHealthPool
    });
    const resultWithHealth = deepFreeze({ ...error.result, source_health: sourceHealth });
    error.resultWithHealth = resultWithHealth;
    if (options.log !== false) console.log(JSON.stringify(resultWithHealth, null, 2));
    throw error;
  }
  let sourceHealth;
  if (hosted?.outcome?.source_health) {
    sourceHealth = hosted.outcome.source_health;
  } else {
    const databaseFallback = await resolveDatabaseFallbackGate({ hosted, environment, options });
    sourceHealth = await persistSourceHealthForRun({
      envelope,
      result,
      recordCount: input.latest.rows.length,
      environment,
      repository: options.sourceHealthRepository,
      clock: options.clock,
      allowDatabaseFallback: enabled,
      databaseFallback,
      createSourceHealthPool: options.createSourceHealthPool
    });
  }
  const resultWithHealth = deepFreeze({
    ...result,
    ...(hosted?.outcome?.normalized_only ? { normalized_only: hosted.outcome.normalized_only } : {}),
    source_health: sourceHealth
  });
  if (options.log !== false) console.log(JSON.stringify(resultWithHealth, null, 2));
  return resultWithHealth;
}

export async function runBootstrapSourceFailure(options = {}) {
  const environment = options.environment || process.env;
  const clock = options.clock || (() => new Date());
  const runId = environment.COLLECTOR_RUN_ID || randomUUID();
  const startedAt = parseInstant(clock(), "started_at");
  const failureMessage = environment.COLLECTOR_SOURCE_FAILURE || "collector step failed before a snapshot was written";
  const envelope = await ingestSourceSnapshot({
    sourceName: "queue-times-bootstrap",
    clock,
    adapter: {
      version: "bootstrap-collector-adapter.v1",
      schemaVersion: "raw-wait-observation.v1",
      sourceUrl: "https://queue-times.com",
      attribution: "Queue-Times",
      fetchSnapshot: async () => { throw new Error(failureMessage); }
    }
  });
  const result = deepFreeze({
    contract_version: "collector-dual-write-result.v1",
    run_id: runId,
    envelope_id: envelope.envelope_id,
    deduplication_key: envelope.envelope_id,
    source_status: envelope.status,
    feature_flag: { name: dualWriteFeatureFlag, enabled: isDualWriteEnabled(environment.COLLECTOR_DUAL_WRITE_ENABLED) },
    started_at: startedAt.toISOString(),
    finished_at: parseInstant(clock(), "finished_at").toISOString(),
    fallback: { status: "not_attempted" },
    hosted: { status: "not_attempted", error: null },
    failure_reason: "collector_source_failed"
  });
  const databaseFallbackEnabled = isDualWriteEnabled(environment.COLLECTOR_DUAL_WRITE_ENABLED);
  const sourceHealth = await persistSourceHealthForRun({
    envelope,
    result,
    recordCount: 0,
    environment,
    repository: options.sourceHealthRepository,
    clock,
    allowDatabaseFallback: databaseFallbackEnabled,
    databaseFallback: await resolveDatabaseFallbackGate({ hosted: null, environment, options }),
    createSourceHealthPool: options.createSourceHealthPool
  });
  const resultWithHealth = deepFreeze({ ...result, source_health: sourceHealth });
  if (options.log !== false) console.log(JSON.stringify(resultWithHealth, null, 2));
  return resultWithHealth;
}

async function persistSourceHealthForRun({
  envelope,
  result,
  recordCount,
  environment,
  repository,
  clock,
  allowDatabaseFallback,
  databaseFallback,
  createSourceHealthPool
}) {
  if (repository) {
    try {
      const record = buildSourceHealthRecord({
        envelope,
        runId: result.run_id,
        recordCount,
        dualWriteResult: result,
        clock
      });
      await persistSourceHealthRecord({ record, repository });
      return { status: "written", source_health_id: record.source_health_id, error: null };
    } catch (error) {
      return { status: "failed", source_health_id: null, error: { type: "source_health_write_error", message: safeErrorMessage(error) } };
    }
  }
  // Default-disabled cloud behavior: without the explicit hosted opt-in the worker
  // never opens the hosted database, even when DATABASE_URL is present in the env.
  if (!allowDatabaseFallback || !environment.DATABASE_URL) {
    return { status: "not_configured", source_health_id: null, error: null };
  }

  // The same current validation-only authorization and target fingerprint that gate
  // normalized-only hosted writes gate every default database fallback, including
  // routing-override rejection, before any pool is created.
  let poolFingerprint;
  try {
    poolFingerprint = calculateDatabaseFingerprint(environment.DATABASE_URL);
  } catch (error) {
    return blockedSourceHealthFallback(error);
  }
  try {
    assertCurrentValidationAuthorization({
      authorization: databaseFallback?.authorization,
      expectedTargetFingerprint: databaseFallback?.expectedTargetFingerprint,
      targetFingerprint: poolFingerprint,
      now: result.finished_at
    });
  } catch (error) {
    return blockedSourceHealthFallback(error);
  }

  let pool = null;
  try {
    pool = createSourceHealthPool
      ? await createSourceHealthPool(environment.DATABASE_URL)
      : await createDefaultSourceHealthPool(environment.DATABASE_URL);
    const schema = await pool.query("SELECT to_regclass($1) AS present", ["ingestion.source_health"]);
    if (!schema.rows?.[0]?.present) {
      return {
        status: "failed",
        source_health_id: null,
        error: {
          type: "source_health_schema_not_ready",
          message: "ingestion.source_health is not present; the sidecar never applies migrations"
        }
      };
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const record = buildSourceHealthRecord({
        envelope,
        runId: result.run_id,
        recordCount,
        dualWriteResult: result,
        clock
      });
      await persistSourceHealthRecord({
        record,
        repository: createPostgresSourceHealthRepository(client)
      });
      await client.query("COMMIT");
      return { status: "written", source_health_id: record.source_health_id, error: null };
    } catch (error) {
      await client.query("ROLLBACK");
      return { status: "failed", source_health_id: null, error: { type: "source_health_write_error", message: safeErrorMessage(error) } };
    } finally {
      client.release();
    }
  } catch (error) {
    return { status: "failed", source_health_id: null, error: { type: "source_health_write_error", message: safeErrorMessage(error) } };
  } finally {
    if (pool) await pool.end().catch(() => {});
  }
}

function blockedSourceHealthFallback(error) {
  return {
    status: "blocked",
    source_health_id: null,
    error: { type: "source_health_fallback_blocked", message: safeErrorMessage(error) }
  };
}

async function createDefaultSourceHealthPool(databaseUrl) {
  const { default: pg } = await import("pg");
  return new pg.Pool({ connectionString: databaseUrl });
}

async function loadLatestSnapshot(rootDir) {
  const latestPath = path.join(rootDir, "data", "wait_times", "latest_snapshot.json");
  const latest = JSON.parse(await readFile(latestPath, "utf8"));
  if (!latest.snapshotUtc || !latest.snapshotParkDate) throw new Error("latest snapshot is missing its timestamp or park date");
  const csvPath = path.join(rootDir, "data", "wait_times", `wait_times_${latest.snapshotParkDate}.csv`);
  const snapshotPayload = Buffer.from(serializeSnapshotRows(latest.rows), "utf8");
  const snapshotId = String(latest.snapshotUtc).replace(/[^0-9]/g, "");
  return {
    latest,
    csvPath,
    sourceName: `wait_times_snapshot_${snapshotId}.csv`,
    content: snapshotPayload
  };
}

async function buildSourceEnvelope(input, clock = () => new Date()) {
  const sourceUrl = "https://queue-times.com";
  return ingestSourceSnapshot({
    sourceName: "queue-times-bootstrap",
    clock,
    adapter: {
      version: "bootstrap-collector-adapter.v1",
      schemaVersion: "raw-wait-observation.v1",
      sourceUrl,
      attribution: "Queue-Times",
      fetchSnapshot: async () => ({
        payload: input.content.toString("utf8"),
        observedAt: input.latest.snapshotUtc,
        sourceUrl
      })
    }
  });
}

function createNormalizedOnlyHostedWriter({ input, environment, options }) {
  const state = { outcome: null, inputs: null };
  const usesInjectedInputs = Boolean(options.normalizedOnlyHosted);

  const resolveInputs = async () => {
    if (!state.inputs) {
      state.inputs = usesInjectedInputs
        ? options.normalizedOnlyHosted
        : await loadNormalizedOnlyHostedInputs(environment);
    }
    return state.inputs;
  };

  const writeHosted = async ({ envelope, runId }) => {
    const inputs = await resolveInputs();
    let adapters = null;
    try {
      adapters = usesInjectedInputs ? null : await createNormalizedOnlyAdapters(inputs, environment);
      const result = await writeNormalizedOnlyHostedSnapshot({
        envelope,
        sourceName: input.sourceName,
        rawRecords: parseSnapshotCsv(envelope.payload).map((row, index) =>
          toRawRecord(row, envelope.payload_sha256, index + 1)),
        runId,
        generatedAt: envelope.ingested_at,
        bucket: inputs.bucket,
        r2: inputs.r2 || adapters.r2,
        database: inputs.database || adapters.database,
        catalogSnapshot: inputs.catalogSnapshot,
        accessModeMapping: inputs.accessModeMapping,
        authorization: inputs.authorization,
        expectedTargetFingerprint: inputs.expectedTargetFingerprint,
        targetFingerprint: inputs.targetFingerprint,
        transformationVersion: inputs.transformationVersion
      });
      state.outcome = {
        source_health: { status: "written", source_health_id: result.source_health_id, error: null },
        normalized_only: {
          contract_version: result.contract_version,
          adapter_version: result.adapter_version,
          schema_version: result.schema_version,
          transformation_version: result.transformation_version,
          archive_sha256: result.archive_sha256,
          object_uri: result.object_uri,
          r2_object_created: result.r2_object_created,
          normalized_records_written: result.normalized_records_written,
          raw_observation_rows_written: result.raw_observation_rows_written
        }
      };
    } finally {
      await adapters?.close?.();
    }
  };

  const resolveGate = async () => {
    try {
      if (usesInjectedInputs) {
        const inputs = options.normalizedOnlyHosted;
        return {
          authorization: inputs.authorization,
          expectedTargetFingerprint: inputs.expectedTargetFingerprint,
          targetFingerprint: inputs.targetFingerprint
        };
      }
      return await loadValidationGateFromEnvironment(environment);
    } catch {
      return null;
    }
  };

  return { writeHosted, resolveDatabaseFallbackGate: resolveGate, get outcome() { return state.outcome; } };
}

async function loadNormalizedOnlyHostedInputs(environment) {
  const bucket = requiredEnvironment(environment.RAW_ARCHIVE_BUCKET, "RAW_ARCHIVE_BUCKET");
  const databaseUrl = requiredEnvironment(environment.DATABASE_URL, "DATABASE_URL");
  const gate = await loadValidationGateFromEnvironment(environment);
  const catalogSnapshot = await readJsonInput(
    requiredEnvironment(environment.NORMALIZED_ONLY_REVIEWED_CATALOG_PATH, "NORMALIZED_ONLY_REVIEWED_CATALOG_PATH")
  );
  const accessModeMapping = await readJsonInput(
    requiredEnvironment(environment.NORMALIZED_ONLY_ACCESS_MODE_MAPPING_PATH, "NORMALIZED_ONLY_ACCESS_MODE_MAPPING_PATH")
  );
  return { bucket, databaseUrl, catalogSnapshot, accessModeMapping, ...gate };
}

async function loadValidationGateFromEnvironment(environment) {
  const databaseUrl = requiredEnvironment(environment.DATABASE_URL, "DATABASE_URL");
  const targetFingerprint = calculateDatabaseFingerprint(databaseUrl);
  const authorization = await readJsonInput(
    requiredEnvironment(environment.NORMALIZED_ONLY_AUTHORIZATION_PATH, "NORMALIZED_ONLY_AUTHORIZATION_PATH")
  );
  const expectedTargetFingerprint = requiredEnvironment(
    environment.NORMALIZED_ONLY_EXPECTED_TARGET_SHA256,
    "NORMALIZED_ONLY_EXPECTED_TARGET_SHA256"
  );
  return { authorization, expectedTargetFingerprint, targetFingerprint };
}

async function createNormalizedOnlyAdapters(inputs, environment) {
  const r2 = await createImmutableArchiveStore(environment);
  const database = await createNormalizedOnlyDatabase(inputs.databaseUrl);
  return { r2, database, close: () => database.close() };
}

async function resolveDatabaseFallbackGate({ hosted, environment, options }) {
  if (hosted) return hosted.resolveDatabaseFallbackGate();
  if (options.normalizedOnlyHosted) {
    const config = options.normalizedOnlyHosted;
    return {
      authorization: config.authorization,
      expectedTargetFingerprint: config.expectedTargetFingerprint,
      targetFingerprint: config.targetFingerprint
    };
  }
  try {
    return await loadValidationGateFromEnvironment(environment);
  } catch {
    return null;
  }
}

async function readJsonInput(filePath) {
  const text = await readFile(filePath, "utf8");
  return JSON.parse(text);
}

async function createImmutableArchiveStore(environment) {
  const { HeadObjectCommand, PutObjectCommand, S3Client } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region: environment.AWS_REGION || "us-west-2",
    endpoint: environment.RAW_ARCHIVE_ENDPOINT || undefined,
    forcePathStyle: Boolean(environment.RAW_ARCHIVE_ENDPOINT)
  });
  return {
    async putObject({ bucket, key, body, metadata }) {
      try {
        await client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: "text/csv; charset=utf-8",
          Metadata: metadata,
          IfNoneMatch: "*"
        }));
        return { created: true };
      } catch (error) {
        if (isPreconditionFailure(error)) return { created: false };
        throw error;
      }
    },
    async headObject({ bucket, key }) {
      const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { contentLength: response.ContentLength, metadata: response.Metadata || {} };
    }
  };
}

function isPreconditionFailure(error) {
  const status = error?.$metadata?.httpStatusCode;
  return status === 412 || status === 409 || error?.name === "PreconditionFailed";
}

async function createNormalizedOnlyDatabase(databaseUrl) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: databaseUrl });
  return {
    async verifyNormalizedSchemaReady() {
      const result = await pool.query(
        `SELECT to_regclass($1) AS archive_lines,
                to_regclass($2) AS normalized,
                to_regclass($3) AS catalog,
                to_regclass($4) AS source_health`,
        [
          "ingestion.raw_archive_line_references",
          "observations.normalized_wait_observations_v2",
          "catalog.catalog_entry_snapshots",
          "ingestion.source_health"
        ]
      );
      const row = result.rows?.[0] || {};
      return Boolean(row.archive_lines && row.normalized && row.catalog && row.source_health);
    },
    async withTransaction(operation) {
      return withPostgresStorageTransaction(pool, (client) => operation({
        archiveLines: createPostgresArchiveLineReferenceRepository(client),
        catalog: createPostgresCatalogRepository(client),
        normalized: createPostgresNormalizedObservationRepository(client),
        sourceHealth: createPostgresSourceHealthRepository(client)
      }));
    },
    async close() {
      await pool.end().catch(() => {});
    }
  };
}

export function toRawRecord(row, rawArchiveId, sourceRowNumber) {
  for (const field of ["snapshot_utc", "snapshot_park_datetime", "snapshot_park_date", "snapshot_timezone", "park_id", "park_name", "ride_id", "ride_name", "source_last_updated_utc", "source_last_updated_park_datetime", "source_url"]) {
    if (!row[field]) throw new Error(`raw CSV row is missing ${field}`);
  }
  if (row.snapshot_timezone !== "America/Los_Angeles") {
    throw new Error(`raw CSV row has unsupported timezone: ${row.snapshot_timezone}`);
  }
  if (formatParkDateTime(row.snapshot_utc, row.snapshot_timezone, "snapshot_utc") !== row.snapshot_park_datetime) {
    throw new Error(`raw CSV row has inconsistent snapshot_park_datetime: ${row.snapshot_park_datetime}`);
  }
  if (formatParkDate(row.snapshot_utc, row.snapshot_timezone) !== row.snapshot_park_date) {
    throw new Error(`raw CSV row has inconsistent snapshot_park_date: ${row.snapshot_park_date}`);
  }
  if (formatParkDateTime(row.source_last_updated_utc, row.snapshot_timezone, "source_last_updated_utc") !== row.source_last_updated_park_datetime) {
    throw new Error(`raw CSV row has inconsistent source_last_updated_park_datetime: ${row.source_last_updated_park_datetime}`);
  }
  if (Number.isNaN(new Date(row.source_last_updated_utc).getTime())) {
    throw new Error(`raw CSV row has invalid source_last_updated_utc: ${row.source_last_updated_utc}`);
  }
  return {
    rawObservationId: hash(`${rawArchiveId}:${sourceRowNumber}`),
    rawArchiveId,
    sourceRowNumber,
    snapshotUtc: row.snapshot_utc,
    snapshotParkDatetime: row.snapshot_park_datetime,
    snapshotParkDate: row.snapshot_park_date,
    snapshotTimezone: row.snapshot_timezone,
    parkId: row.park_id,
    parkName: row.park_name,
    land: row.land || "Other",
    rideId: row.ride_id,
    rideName: row.ride_name,
    isOpen: parseBoolean(row.is_open),
    waitTimeMinutes: parseNullableNumber(row.wait_time_minutes),
    sourceLastUpdatedUtc: row.source_last_updated_utc,
    sourceLastUpdatedParkDatetime: row.source_last_updated_park_datetime,
    sourceUrl: row.source_url
  };
}

export function parseSnapshotCsv(text) {
  const source = String(text).replace(/^\uFEFF/, "");
  const records = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some((value) => value !== "")) records.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    records.push(row);
  }
  const [header, ...values] = records;
  if (!header) throw new Error("raw CSV is empty");
  return values.map((record) => Object.fromEntries(header.map((key, index) => [key, record[index] ?? ""])));
}

function parseBoolean(value) {
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  throw new Error(`invalid is_open value: ${value}`);
}

function parseNullableNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`invalid wait_time_minutes value: ${value}`);
  return number;
}

function requiredEnvironment(value, name) {
  if (!value) throw new Error(`${name} is required when collector dual write is enabled`);
  return value;
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function formatParkDate(value, timezone) {
  return formatParkDateTime(value, timezone, "snapshot_utc").slice(0, 10);
}

function formatParkDateTime(value, timezone, field) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`raw CSV row has invalid ${field}: ${value}`);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeErrorMessage(error) {
  return String(error && error.message ? error.message : error)
    .replace(/([a-z][a-z\d+.-]*:\/\/)([^/\s@]+)@/gi, "$1[redacted]@")
    .replace(/([?&](?:password|token|secret|key|access[_-]?key)\s*=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 500);
}

function parseInstant(value, field) {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) throw new TypeError(`invalid ${field}`);
  return instant;
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Exit decision for the direct CLI. A hosted failure must fail the workflow step
 * (making `Surface dual-write failure` reachable) even though the Git fallback
 * already committed; a disabled or not-attempted hosted leg is not an error.
 */
export function resolveSidecarExitCode(result) {
  if (!result || typeof result !== "object") return 1;
  if (result.source_health?.status === "failed") return 1;
  if (result.hosted?.status === "failed") return 1;
  return 0;
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  try {
    const result = await runBootstrapDualWrite();
    const exitCode = resolveSidecarExitCode(result);
    if (exitCode !== 0) {
      console.error(
        result?.hosted?.status === "failed"
          ? safeErrorMessage(result.hosted.error?.message || "hosted normalized write failed")
          : result?.source_health?.error?.message || "source health persistence failed"
      );
    }
    process.exitCode = exitCode;
  } catch (error) {
    console.error(safeErrorMessage(error instanceof Error ? error.message : error));
    process.exitCode = 1;
  }
}
