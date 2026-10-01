import { createHash } from "node:crypto";
import { resolveCanonicalAttraction } from "../modules/catalog/index.mjs";
import { buildSourceHealthRecord } from "../modules/ingestion/source-health.mjs";
import { normalizeArchivedWaitObservation } from "../modules/observations/index.mjs";
import { calculateRawObservationId } from "./archive-line-reference-postgres.mjs";

export const normalizedOnlyResultVersion = "normalized-only-hosted-result.v1";
export const normalizedOnlyAdapterVersion = "collector-normalized-sidecar.v1";
export const normalizedOnlyTransformationVersion = "collector-normalized-snapshot.v1";

const RAW_SCHEMA_VERSION = "raw-wait-observation.v1";
const ARCHIVE_REFERENCE_VERSION = "raw-archive-line-reference.v1";
const ACCESS_MODES = new Set(["standby", "single_rider", "virtual_queue", "other"]);
const SHA256 = /^[a-f0-9]{64}$/;

export class NormalizedOnlyHostedError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "NormalizedOnlyHostedError";
    this.code = code;
  }
}

/**
 * Fingerprint a PostgreSQL target by canonical host/port/database only. Credentials,
 * query strings, and user info are intentionally excluded so the value is safe to
 * compare, log, and persist as a non-secret target identity.
 *
 * Query-string routing overrides are rejected: node-postgres merges URL query keys
 * into its connection config, so a URL like `?host=...`/`?port=...`/`?database=...`
 * could route the pool to a different server than the one this fingerprint blesses.
 */
export function calculateDatabaseFingerprint(connectionString) {
  if (typeof connectionString !== "string" || connectionString.trim() === "") {
    throw new TypeError("connectionString is required");
  }
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new TypeError("connectionString must be a valid PostgreSQL URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new TypeError("connectionString must use the postgres: or postgresql: protocol");
  }
  const routingOverride = [...url.searchParams.keys()]
    .map((key) => key.toLowerCase())
    .find((key) => DATABASE_ROUTING_OVERRIDE_KEYS.has(key));
  if (routingOverride) {
    throw new TypeError(`connectionString must not contain a ${routingOverride} routing override`);
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!url.hostname || !database) {
    throw new TypeError("connectionString must include a host and a database name");
  }
  const identity = JSON.stringify({
    host: url.hostname.toLowerCase(),
    port: url.port || "5432",
    database
  });
  return createHash("sha256").update(identity, "utf8").digest("hex");
}

// pg (via pg-connection-string) copies unknown query keys onto its config, and its
// connection parameters read host/hostaddr/port/database (plus common aliases in
// deployment tooling), so these keys can change where the pool actually connects.
const DATABASE_ROUTING_OVERRIDE_KEYS = new Set([
  "host",
  "hostaddr",
  "port",
  "database",
  "db",
  "dbname"
]);

/**
 * Shared authorization/target gate for every hosted database write (normalized
 * snapshot writes and the source-health fallback). Throws before any pool is
 * created when the authorization is absent, malformed, expired/not-yet-valid,
 * or bound to a different target than the expected fingerprint.
 */
export function assertCurrentValidationAuthorization({
  authorization,
  expectedTargetFingerprint,
  targetFingerprint,
  now
} = {}) {
  if (!authorization || authorization.kind !== "validation-only" ||
      !isNonEmptyString(authorization.approvedBy) ||
      !isDateTime(authorization.approvedAt) || !isDateTime(authorization.expiresAt) ||
      !SHA256.test(authorization.targetFingerprint || "")) {
    throw new NormalizedOnlyHostedError(
      "normalized_only_authorization_invalid",
      "current_validation_only_authorization_required"
    );
  }
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) {
    throw new NormalizedOnlyHostedError(
      "normalized_only_authorization_invalid",
      "authorization_clock_invalid"
    );
  }
  if (Date.parse(authorization.approvedAt) > nowMs) {
    throw new NormalizedOnlyHostedError(
      "normalized_only_authorization_invalid",
      "authorization_not_yet_valid"
    );
  }
  if (Date.parse(authorization.expiresAt) <= nowMs) {
    throw new NormalizedOnlyHostedError(
      "normalized_only_authorization_invalid",
      "authorization_expired"
    );
  }
  if (!SHA256.test(expectedTargetFingerprint || "")) {
    throw new NormalizedOnlyHostedError(
      "normalized_only_authorization_invalid",
      "expected_target_fingerprint_required"
    );
  }
  if (authorization.targetFingerprint !== expectedTargetFingerprint) {
    throw new NormalizedOnlyHostedError(
      "normalized_only_target_fingerprint_mismatch",
      "authorization target fingerprint does not match the expected normalized database fingerprint"
    );
  }
  if (typeof targetFingerprint === "string" && targetFingerprint !== expectedTargetFingerprint) {
    throw new NormalizedOnlyHostedError(
      "normalized_only_target_fingerprint_mismatch",
      "the configured database fingerprint does not match the expected normalized database fingerprint"
    );
  }
  return true;
}

/**
 * One explicit-opt-in live snapshot write:
 * - immutable R2 object first (complete envelope payload bytes + hash metadata),
 * - then exactly one caller-owned transaction over the 04d3 ports writing catalog
 *   entries, archive-line references, normalized v2 records, and source health.
 * It never writes raw observations and never applies migrations.
 */
export async function writeNormalizedOnlyHostedSnapshot(options = {}) {
  const validation = validateHostedInputs(options);
  if (validation.blockers.length > 0) {
    throw new NormalizedOnlyHostedError(
      "normalized_only_inputs_invalid",
      `normalized-only hosted inputs invalid: ${validation.blockers.join(", ")}`
    );
  }

  const {
    envelope,
    rawRecords,
    sourceName,
    runId,
    generatedAt,
    bucket,
    r2,
    database,
    catalogSnapshot,
    accessModeMapping,
    authorization,
    expectedTargetFingerprint,
    targetFingerprint,
    transformationVersion = normalizedOnlyTransformationVersion,
    staleAfterMinutes = 60,
    fallbackStatus = "written"
  } = options;
  const archiveSha256 = envelope.payload_sha256;

  assertCurrentValidationAuthorization({
    authorization,
    expectedTargetFingerprint,
    targetFingerprint,
    now: generatedAt
  });
  if (typeof database.verifyTargetIdentity === "function") {
    let verified;
    try {
      verified = await database.verifyTargetIdentity({ expectedTargetFingerprint, targetFingerprint });
    } catch (error) {
      throw new NormalizedOnlyHostedError(
        "normalized_only_target_verification_failed",
        `normalized target identity verification failed: ${safeErrorMessage(error)}`
      );
    }
    if (verified !== true) {
      throw new NormalizedOnlyHostedError(
        "normalized_only_target_identity_mismatch",
        "the injected target identity verifier rejected the normalized database target"
      );
    }
  }

  const objectKey = `wait-times/${archiveSha256}/${sourceName}`;
  const objectUri = `s3://${bucket}/${objectKey}`;
  const archiveByteSize = Buffer.byteLength(envelope.payload, "utf8");
  const records = buildNormalizedRecords({
    rawRecords,
    archiveSha256,
    archiveByteSize,
    objectUri,
    sourceName,
    catalogSnapshot,
    accessModes: validation.accessModes,
    generatedAt,
    transformationVersion,
    staleAfterMinutes
  });

  const schemaReady = await verifySchemaReady(database);
  if (schemaReady !== true) {
    throw new NormalizedOnlyHostedError(
      "normalized_schema_not_ready",
      "the normalized 0004 relations are not present; hosted writes stay blocked until an authorized migration is applied"
    );
  }

  const body = Buffer.from(envelope.payload, "utf8");
  let putResult;
  try {
    putResult = await r2.putObject({
      bucket,
      key: objectKey,
      body,
      metadata: { sha256: archiveSha256, schema_version: RAW_SCHEMA_VERSION }
    });
  } catch (error) {
    throw new NormalizedOnlyHostedError(
      "r2_upload_failed",
      `immutable R2 upload failed: ${safeErrorMessage(error)}`
    );
  }
  let headResult;
  try {
    headResult = await r2.headObject({ bucket, key: objectKey });
  } catch (error) {
    throw new NormalizedOnlyHostedError(
      "r2_verification_failed",
      `stored R2 object could not be verified: ${safeErrorMessage(error)}`
    );
  }
  if (!headResult || headResult.metadata?.sha256 !== archiveSha256 ||
      headResult.contentLength !== body.byteLength) {
    throw new NormalizedOnlyHostedError(
      "r2_object_verification_mismatch",
      "the stored R2 object does not match the immutable snapshot hash or byte size"
    );
  }

  let sourceHealthId = null;
  try {
    await database.withTransaction(async (repositories) => {
      for (const entry of uniqueCatalogEntries(records)) {
        await repositories.catalog.putCatalogEntry(entry);
      }
      for (const record of records) {
        await repositories.archiveLines.putArchiveLineReference(record.archiveLineReference);
      }
      for (const record of records) {
        await repositories.normalized.putNormalizedObservation(record.normalizedObservation);
      }
      const healthRecord = buildSourceHealthRecord({
        envelope,
        runId,
        recordCount: records.length,
        fallbackStatus,
        hostedWriteStatus: "written",
        clock: () => new Date(generatedAt)
      });
      await repositories.sourceHealth.upsertSourceHealth(healthRecord);
      sourceHealthId = healthRecord.source_health_id;
    });
  } catch (error) {
    throw new NormalizedOnlyHostedError(
      "hosted_transaction_failed",
      `normalized-only hosted transaction failed and was rolled back: ${safeErrorMessage(error)}`
    );
  }

  return deepFreeze({
    contract_version: normalizedOnlyResultVersion,
    status: "written",
    run_id: runId,
    adapter_version: normalizedOnlyAdapterVersion,
    schema_version: RAW_SCHEMA_VERSION,
    transformation_version: transformationVersion,
    archive_sha256: archiveSha256,
    archive_byte_size: archiveByteSize,
    object_uri: objectUri,
    r2_object_created: putResult?.created === true,
    normalized_records_written: records.length,
    raw_observation_rows_written: 0,
    source_health_id: sourceHealthId
  });
}

function validateHostedInputs(options) {
  const blockers = [];
  const {
    envelope,
    rawRecords,
    sourceName,
    runId,
    generatedAt,
    bucket,
    r2,
    database,
    catalogSnapshot,
    accessModeMapping
  } = options || {};

  if (!envelope || envelope.contract_version !== "source-envelope.v1" ||
      !SHA256.test(envelope.envelope_id || "") || !SHA256.test(envelope.payload_sha256 || "") ||
      typeof envelope.payload !== "string" || envelope.payload === "") {
    blockers.push("source_envelope_v1_with_payload_required");
  }
  if (typeof sourceName !== "string" || sourceName.trim() === "" || /[\\/]/.test(sourceName)) {
    blockers.push("safe_snapshot_source_name_required");
  }
  if (!Array.isArray(rawRecords) || rawRecords.length === 0) blockers.push("snapshot_rows_required");
  if (typeof runId !== "string" || runId.trim() === "") blockers.push("run_id_required");
  if (!isUtcDateTime(generatedAt)) blockers.push("generated_at_must_be_utc");
  if (typeof bucket !== "string" || bucket.trim() === "" || /[\\/]/.test(bucket)) {
    blockers.push("raw_archive_bucket_required");
  }
  if (!r2 || typeof r2.putObject !== "function" || typeof r2.headObject !== "function") {
    blockers.push("r2_immutable_store_required");
  }
  if (!database || typeof database.withTransaction !== "function" ||
      typeof database.verifyNormalizedSchemaReady !== "function") {
    blockers.push("normalized_database_port_required");
  }

  if (!catalogSnapshot || catalogSnapshot.status !== "reviewed" ||
      !isNonEmptyString(catalogSnapshot.catalog_version) ||
      !isNonEmptyString(catalogSnapshot.reviewed_by) ||
      !isDateTime(catalogSnapshot.reviewed_at) ||
      !Array.isArray(catalogSnapshot.entries) || catalogSnapshot.entries.length === 0) {
    blockers.push("reviewed_catalog_entry_v1_snapshot_required");
  } else {
    for (const [index, entry] of catalogSnapshot.entries.entries()) {
      try {
        if (entry?.contract_version !== "catalog-entry.v1" ||
            entry.lifecycle?.catalog_version !== catalogSnapshot.catalog_version) {
          throw new Error("catalog snapshot version mismatch");
        }
        resolveCanonicalAttraction({
          parkId: entry.park_id,
          sourceAttractionName: entry.aliases?.[0],
          catalogEntries: [entry],
          asOfDate: entry.lifecycle?.valid_from
        });
      } catch {
        blockers.push(`invalid_reviewed_catalog_entry_${index}`);
      }
    }
  }

  const accessModes = new Map();
  if (!accessModeMapping || accessModeMapping.status !== "reviewed" ||
      !isNonEmptyString(accessModeMapping.catalog_version) ||
      !isNonEmptyString(accessModeMapping.reviewed_by) ||
      !isDateTime(accessModeMapping.reviewed_at) ||
      !Array.isArray(accessModeMapping.mappings) ||
      accessModeMapping.catalog_version !== catalogSnapshot?.catalog_version) {
    blockers.push("reviewed_structured_access_mode_mapping_required");
  } else {
    for (const [index, mapping] of accessModeMapping.mappings.entries()) {
      if (!hasOnlyKeys(mapping, ["park_id", "ride_id", "access_mode"]) ||
          !isNonEmptyString(mapping?.park_id) || !isNonEmptyString(mapping?.ride_id) ||
          !ACCESS_MODES.has(mapping?.access_mode)) {
        blockers.push(`invalid_access_mode_mapping_${index}`);
        continue;
      }
      const key = accessMappingKey(mapping.park_id, mapping.ride_id);
      if (accessModes.has(key)) {
        blockers.push(`duplicate_access_mode_mapping_${index}`);
        continue;
      }
      accessModes.set(key, mapping.access_mode);
    }
  }
  return { blockers, accessModes };
}

function buildNormalizedRecords({
  rawRecords,
  archiveSha256,
  archiveByteSize,
  objectUri,
  sourceName,
  catalogSnapshot,
  accessModes,
  generatedAt,
  transformationVersion,
  staleAfterMinutes
}) {
  const records = [];
  for (const [index, raw] of rawRecords.entries()) {
    const sourceRowNumber = Number.isInteger(raw?.sourceRowNumber) ? raw.sourceRowNumber : index + 1;
    try {
      if (raw?.rawArchiveId !== archiveSha256) {
        throw preflightFailure("RAW_ARCHIVE_MISMATCH", "raw record archive identity does not match the envelope payload hash");
      }
      const expectedId = calculateRawObservationId(archiveSha256, sourceRowNumber);
      if (raw.rawObservationId !== expectedId) {
        throw preflightFailure("RAW_OBSERVATION_ID_MISMATCH", "raw observation id does not match the stable archive-line key");
      }
      const rawObservation = toRawObservationV1(raw);
      const archiveLineReference = {
        contract_version: ARCHIVE_REFERENCE_VERSION,
        raw_observation_id: expectedId,
        raw_archive_id: archiveSha256,
        r2_uri: objectUri,
        archive_sha256: archiveSha256,
        archive_byte_size: archiveByteSize,
        source_line_number: sourceRowNumber,
        source_name: sourceName,
        archive_schema_version: RAW_SCHEMA_VERSION
      };
      const accessMode = accessModes.get(accessMappingKey(rawObservation.park_id, rawObservation.ride_id));
      if (!accessMode) {
        throw preflightFailure("MISSING_ACCESS_MODE", "no reviewed access mode is mapped for the row");
      }
      const normalizedObservation = normalizeArchivedWaitObservation({
        rawObservation,
        archiveLineReference,
        catalogEntries: catalogSnapshot.entries,
        accessMode,
        generatedAt,
        transformationVersion,
        staleAfterMinutes
      });
      const asOfDate = parkLocalDate(normalizedObservation.observed_at_utc, normalizedObservation.park_timezone);
      const catalogEntry = catalogSnapshot.entries.find((entry) =>
        entry.park_id === normalizedObservation.park_id &&
        entry.canonical_attraction_id === normalizedObservation.canonical_attraction_id &&
        asOfDate >= entry.lifecycle.valid_from &&
        (entry.lifecycle.valid_to === null || asOfDate < entry.lifecycle.valid_to)
      );
      if (!catalogEntry) {
        throw preflightFailure("RESOLVED_CATALOG_SNAPSHOT_NOT_FOUND", "the resolved catalog snapshot entry is missing");
      }
      records.push({ archiveLineReference, normalizedObservation, catalogEntry });
    } catch (error) {
      const code = error?.code || "NORMALIZATION_PREFLIGHT_FAILED";
      throw new NormalizedOnlyHostedError(
        "normalization_preflight_failed",
        `snapshot row ${sourceRowNumber} failed preflight: ${code}`
      );
    }
  }
  return records;
}

function toRawObservationV1(raw) {
  return {
    contract_version: RAW_SCHEMA_VERSION,
    raw_observation_id: raw.rawObservationId,
    raw_archive_id: raw.rawArchiveId,
    source_row_number: raw.sourceRowNumber,
    snapshot_utc: raw.snapshotUtc,
    snapshot_park_datetime: raw.snapshotParkDatetime,
    snapshot_park_date: raw.snapshotParkDate,
    snapshot_timezone: raw.snapshotTimezone,
    park_id: raw.parkId,
    park_name: raw.parkName,
    land: raw.land,
    ride_id: raw.rideId,
    ride_name: raw.rideName,
    is_open: raw.isOpen,
    wait_time_minutes: raw.waitTimeMinutes,
    source_last_updated_utc: raw.sourceLastUpdatedUtc,
    source_last_updated_park_datetime: raw.sourceLastUpdatedParkDatetime,
    source_url: raw.sourceUrl
  };
}

function uniqueCatalogEntries(records) {
  const entries = new Map();
  for (const record of records) {
    const entry = record.catalogEntry;
    const key = [entry.park_id, entry.canonical_attraction_id, entry.lifecycle.catalog_version, entry.lifecycle.valid_from].join("\u001f");
    entries.set(key, entry);
  }
  return [...entries.values()];
}

async function verifySchemaReady(database) {
  try {
    return await database.verifyNormalizedSchemaReady();
  } catch (error) {
    throw new NormalizedOnlyHostedError(
      "normalized_schema_verification_failed",
      `normalized schema readiness check failed: ${safeErrorMessage(error)}`
    );
  }
}

function parkLocalDate(timestamp, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function accessMappingKey(parkId, rideId) {
  return `${parkId}\u001f${rideId}`;
}

function preflightFailure(code, message) {
  return Object.assign(new Error(message), { code });
}

function safeErrorMessage(error) {
  return String(error && error.message ? error.message : error)
    .replace(/([a-z][a-z\d+.-]*:\/\/)([^/\s@]+)@/gi, "$1[redacted]@")
    .replace(/([?&](?:password|token|secret|key|access[_-]?key)\s*=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 500);
}

function hasOnlyKeys(value, allowedKeys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)) &&
    Object.keys(value).every((key) => allowedKeys.includes(key));
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isDateTime(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match || !isCalendarDate(match[1]) || Number(match[2]) > 23 ||
      Number(match[3]) > 59 || Number(match[4]) > 59 ||
      (match[6] && (Number(match[6]) > 23 || Number(match[7]) > 59))) return false;
  return !Number.isNaN(Date.parse(value));
}

function isUtcDateTime(value) {
  return isDateTime(value) && value.endsWith("Z");
}

function isCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
