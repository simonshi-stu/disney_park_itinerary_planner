import { createHash, randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ingestSourceSnapshot } from "../../modules/ingestion/index.mjs";
import { buildSourceHealthRecord, persistSourceHealthRecord } from "../../modules/ingestion/source-health.mjs";
import { runMigrations } from "../../infra/migrations/run-migrations.mjs";
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
  const writeHosted = enabled ? createHostedWriter(input, environment) : undefined;
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
    const sourceHealth = await persistSourceHealthForRun({
      envelope,
      result: error.result,
      recordCount: input.latest.rows.length,
      environment,
      repository: options.sourceHealthRepository,
      clock: options.clock
    });
    const resultWithHealth = deepFreeze({ ...error.result, source_health: sourceHealth });
    error.resultWithHealth = resultWithHealth;
    if (options.log !== false) console.log(JSON.stringify(resultWithHealth, null, 2));
    throw error;
  }
  const sourceHealth = await persistSourceHealthForRun({
    envelope,
    result,
    recordCount: input.latest.rows.length,
    environment,
    repository: options.sourceHealthRepository,
    clock: options.clock
  });
  const resultWithHealth = deepFreeze({ ...result, source_health: sourceHealth });
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
  const sourceHealth = await persistSourceHealthForRun({
    envelope,
    result,
    recordCount: 0,
    environment,
    repository: options.sourceHealthRepository,
    clock
  });
  const resultWithHealth = deepFreeze({ ...result, source_health: sourceHealth });
  if (options.log !== false) console.log(JSON.stringify(resultWithHealth, null, 2));
  return resultWithHealth;
}

async function persistSourceHealthForRun({ envelope, result, recordCount, environment, repository, clock }) {
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
  if (!environment.DATABASE_URL) return { status: "not_configured", source_health_id: null, error: null };

  let pool = null;
  try {
    const { default: pg } = await import("pg");
    pool = new pg.Pool({ connectionString: environment.DATABASE_URL });
    await runMigrations({ pool });
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

function createHostedWriter(input, environment) {
  return async ({ envelope }) => {
    const bucket = requiredEnvironment(environment.RAW_ARCHIVE_BUCKET, "RAW_ARCHIVE_BUCKET");
    const databaseUrl = requiredEnvironment(environment.DATABASE_URL, "DATABASE_URL");
    const objectUri = await uploadArchive({ envelope, input, bucket, environment });
    await persistRawSnapshot({ envelope, input, databaseUrl, objectUri });
  };
}

async function uploadArchive({ envelope, input, bucket, environment }) {
  const { PutObjectCommand, S3Client } = await import("@aws-sdk/client-s3");
  const region = environment.AWS_REGION || "us-west-2";
  const client = new S3Client({
    region,
    endpoint: environment.RAW_ARCHIVE_ENDPOINT || undefined,
    forcePathStyle: Boolean(environment.RAW_ARCHIVE_ENDPOINT)
  });
  const key = `wait-times/${envelope.payload_sha256}/${input.sourceName}`;
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: Buffer.from(envelope.payload, "utf8"),
    ContentType: "text/csv; charset=utf-8",
    Metadata: {
      sha256: envelope.payload_sha256,
      schema_version: envelope.schema_version
    }
  }));
  return `s3://${bucket}/${key}`;
}

export async function persistRawSnapshot({ envelope, input, databaseUrl, objectUri, pool: suppliedPool, migrate = runMigrations }) {
  const rawArchiveId = envelope.payload_sha256;
  const rows = parseSnapshotCsv(input.content.toString("utf8"));
  const rawRecords = rows.map((row, index) => toRawRecord(row, rawArchiveId, index + 1));
  let pool = suppliedPool;
  const ownsPool = !pool;
  if (!pool) {
    const { default: pg } = await import("pg");
    pool = new pg.Pool({ connectionString: databaseUrl });
  }

  try {
    await migrate({ pool });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await insertRows(client, "catalog.parks", ["park_id", "park_name", "timezone"], uniqueBy(
        rawRecords.map((row) => [row.parkId, row.parkName, row.snapshotTimezone]),
        (row) => row[0]
      ));
      await insertRows(client, "ingestion.raw_archives", ["raw_archive_id", "sha256", "object_uri", "byte_size", "source_name", "schema_version"], [[
        rawArchiveId,
        rawArchiveId,
        objectUri,
        Buffer.byteLength(envelope.payload, "utf8"),
        input.sourceName,
        envelope.schema_version
      ]]);
      await insertRows(client, "ingestion.raw_wait_observations", [
        "raw_observation_id", "raw_archive_id", "source_row_number", "snapshot_utc", "snapshot_park_datetime", "snapshot_park_date", "snapshot_timezone",
        "park_id", "park_name", "land", "ride_id", "ride_name", "is_open", "wait_time_minutes", "source_last_updated_utc",
        "source_last_updated_park_datetime", "source_url"
      ], rawRecords.map((row) => [
        row.rawObservationId, row.rawArchiveId, row.sourceRowNumber, row.snapshotUtc, row.snapshotParkDatetime, row.snapshotParkDate, row.snapshotTimezone,
        row.parkId, row.parkName, row.land, row.rideId, row.rideName, row.isOpen, row.waitTimeMinutes, row.sourceLastUpdatedUtc,
        row.sourceLastUpdatedParkDatetime, row.sourceUrl
      ]));
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    if (ownsPool) await pool.end();
  }
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

async function insertRows(client, table, columns, rows) {
  const batchSize = 200;
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const placeholders = batch.map((_, rowIndex) =>
      `(${columns.map((__, columnIndex) => `$${rowIndex * columns.length + columnIndex + 1}`).join(",")})`
    ).join(",");
    await client.query(`INSERT INTO ${table} (${columns.join(",")}) VALUES ${placeholders} ON CONFLICT DO NOTHING`, batch.flat());
  }
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

function uniqueBy(rows, key) {
  return [...new Map(rows.map((row) => [key(row), row])).values()];
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

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  try {
    const result = await runBootstrapDualWrite();
    if (result.source_health?.status === "failed") {
      console.error(result.source_health.error?.message || "source health persistence failed");
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
