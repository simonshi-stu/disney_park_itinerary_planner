import { createHash } from "node:crypto";
import { resolveCanonicalAttraction } from "../../catalog/index.mjs";

const ACCESS_MODES = new Set(["standby", "single_rider", "virtual_queue", "other"]);
const SHA256 = /^[a-f0-9]{64}$/;
const RAW_REQUIRED_FIELDS = [
  "contract_version",
  "raw_observation_id",
  "raw_archive_id",
  "source_row_number",
  "snapshot_utc",
  "snapshot_timezone",
  "park_id",
  "ride_id",
  "ride_name",
  "is_open",
  "source_last_updated_utc",
  "source_url"
];
const RAW_OPTIONAL_FIELDS = [
  "snapshot_park_datetime",
  "snapshot_park_date",
  "park_name",
  "land",
  "wait_time_minutes",
  "source_last_updated_park_datetime"
];
const RAW_FIELDS = new Set([...RAW_REQUIRED_FIELDS, ...RAW_OPTIONAL_FIELDS]);
const ARCHIVE_LINE_REFERENCE_FIELDS = new Set([
  "contract_version",
  "raw_observation_id",
  "raw_archive_id",
  "r2_uri",
  "archive_sha256",
  "archive_byte_size",
  "source_line_number",
  "source_name",
  "archive_schema_version"
]);
const RAW_OPTIONAL_STRING_FIELDS = [
  "snapshot_park_datetime",
  "park_name",
  "land",
  "source_last_updated_park_datetime"
];

export class ArchivedObservationNormalizationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ArchivedObservationNormalizationError";
    this.code = code;
  }
}

/** Convert a raw v1 observation plus its immutable archive-line reference to normalized v2. */
export function normalizeArchivedWaitObservation({
  rawObservation,
  archiveLineReference,
  catalogEntries,
  accessMode,
  generatedAt,
  transformationVersion = "target-normalizer.v2",
  staleAfterMinutes = 60
} = {}) {
  validateRawObservation(rawObservation);
  validateArchiveLineReference(archiveLineReference);
  if (!Number.isFinite(staleAfterMinutes) || staleAfterMinutes < 0) fail("INVALID_POLICY", "staleAfterMinutes must be non-negative");
  if (typeof transformationVersion !== "string" || transformationVersion.trim().length === 0) {
    fail("INVALID_TRANSFORMATION_VERSION", "transformationVersion is required");
  }
  const generatedAtUtc = parseUtcOutputTime(generatedAt, "generatedAt");
  const observedAtUtc = parseInstant(rawObservation.snapshot_utc, "snapshot_utc");
  const sourceUpdatedAtUtc = parseInstant(rawObservation.source_last_updated_utc, "source_last_updated_utc");
  const sourceTimezone = validateTimezone(rawObservation.snapshot_timezone, "snapshot_timezone");
  const archiveLineId = calculateRawObservationId(
    archiveLineReference.archive_sha256,
    archiveLineReference.source_line_number
  );

  if (archiveLineReference.raw_observation_id !== archiveLineId ||
      rawObservation.raw_observation_id !== archiveLineId ||
      rawObservation.raw_archive_id !== archiveLineReference.raw_archive_id ||
      rawObservation.source_row_number !== archiveLineReference.source_line_number ||
      archiveLineReference.archive_schema_version !== rawObservation.contract_version) {
    fail("LINEAGE_MISMATCH", "raw observation and archive-line reference do not share the computed lineage");
  }

  const asOfDate = parkLocalDate(observedAtUtc, sourceTimezone);
  if (rawObservation.snapshot_park_date !== undefined && rawObservation.snapshot_park_date !== asOfDate) {
    fail("PARK_DATE_MISMATCH", "snapshot_park_date does not match snapshot_utc in snapshot_timezone");
  }
  const attraction = resolveCanonicalAttraction({
    parkId: rawObservation.park_id,
    sourceAttractionName: rawObservation.ride_name,
    catalogEntries,
    asOfDate
  });
  if (sourceTimezone !== attraction.park_timezone) {
    fail("PARK_TIMEZONE_MISMATCH", "raw observation timezone does not match the catalog park timezone");
  }

  const resolvedAccessMode = accessMode;
  if (resolvedAccessMode === undefined || resolvedAccessMode === null || resolvedAccessMode === "") {
    fail("ACCESS_MODE_REQUIRED", "a structured accessMode is required");
  }
  if (!ACCESS_MODES.has(resolvedAccessMode)) fail("INVALID_ACCESS_MODE", "accessMode is unsupported");
  if (!attraction.supported_access_modes.includes(resolvedAccessMode)) {
    fail("UNSUPPORTED_ACCESS_MODE", "accessMode is not supported by the resolved catalog entry");
  }

  const isOpen = rawObservation.is_open;
  const waitTimeMinutes = parseNullableWait(rawObservation.wait_time_minutes);
  const sourceAgeMinutes = Math.max(0, (observedAtUtc.getTime() - sourceUpdatedAtUtc.getTime()) / 60_000);
  const isStale = sourceAgeMinutes > staleAfterMinutes;
  const qualityFlags = [];
  if (!isOpen) qualityFlags.push("closed");
  else if (waitTimeMinutes === null) qualityFlags.push("missing_wait");
  else if (waitTimeMinutes === 0) qualityFlags.push("open_zero");
  if (isStale) qualityFlags.push("stale_source");
  if (attraction.operational_state === "unknown") qualityFlags.push("catalog_review_required");
  else if (["refurbishment", "retired"].includes(attraction.operational_state)) qualityFlags.push("lifecycle_ineligible");
  if (attraction.wait_capability !== "posted_standby") qualityFlags.push("no_posted_standby_wait");

  const trainingEligibility = determineTrainingEligibility({
    attraction,
    accessMode: resolvedAccessMode,
    isOpen,
    waitTimeMinutes,
    isStale
  });
  const normalizedObservationId = sha256(`${archiveLineId}:${transformationVersion}`);

  return {
    contract_version: "normalized-wait-observation.v2",
    normalized_observation_id: normalizedObservationId,
    raw_observation_id: archiveLineId,
    operator_id: attraction.operator_id,
    resort_id: attraction.resort_id,
    park_id: attraction.park_id,
    park_timezone: attraction.park_timezone,
    observed_at_utc: observedAtUtc.toISOString(),
    canonical_attraction_id: attraction.canonical_attraction_id,
    canonical_attraction_name: attraction.canonical_attraction_name,
    canonical_category: attraction.canonical_category,
    canonical_match_source: attraction.canonical_match_source,
    access_mode: resolvedAccessMode,
    is_open: isOpen,
    observed_wait_time_minutes: isOpen ? waitTimeMinutes : null,
    quality_flags: qualityFlags,
    training_eligibility: trainingEligibility,
    transformation_version: transformationVersion,
    generated_at: generatedAtUtc
  };
}

function validateRawObservation(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("INVALID_RAW_OBSERVATION", "rawObservation must be an object");
  for (const field of RAW_REQUIRED_FIELDS) {
    if (!Object.hasOwn(raw, field)) fail("INVALID_RAW_OBSERVATION", `${field} is required by raw-wait-observation.v1`);
  }
  const unexpectedFields = Object.keys(raw).filter((field) => !RAW_FIELDS.has(field));
  if (unexpectedFields.length > 0) {
    fail("INVALID_RAW_OBSERVATION", `raw-wait-observation.v1 does not allow ${unexpectedFields.join(", ")}`);
  }
  if (raw.contract_version !== "raw-wait-observation.v1") fail("INVALID_RAW_OBSERVATION", "raw-wait-observation.v1 is required");
  if (typeof raw.raw_observation_id !== "string" || !SHA256.test(raw.raw_observation_id) ||
      typeof raw.raw_archive_id !== "string" || !SHA256.test(raw.raw_archive_id)) {
    fail("INVALID_RAW_OBSERVATION", "raw observation IDs must be SHA-256 hex values");
  }
  if (!Number.isInteger(raw.source_row_number) || raw.source_row_number < 1) {
    fail("INVALID_RAW_OBSERVATION", "source_row_number must be a one-based data-row ordinal");
  }
  parseInstant(raw.snapshot_utc, "snapshot_utc");
  parseInstant(raw.source_last_updated_utc, "source_last_updated_utc");
  if (typeof raw.snapshot_timezone !== "string") {
    fail("INVALID_RAW_OBSERVATION", "snapshot_timezone must be a string");
  }
  if (raw.snapshot_timezone !== "America/Los_Angeles") {
    validateTimezone(raw.snapshot_timezone, "snapshot_timezone");
    fail("INVALID_RAW_OBSERVATION", "snapshot_timezone must match the raw v1 contract constant");
  }
  if (typeof raw.park_id !== "string" || raw.park_id.length === 0 ||
      typeof raw.ride_id !== "string" || raw.ride_id.length === 0 ||
      typeof raw.ride_name !== "string" || raw.ride_name.trim().length === 0) {
    fail("INVALID_RAW_OBSERVATION", "raw park and attraction identity are required");
  }
  if (typeof raw.is_open !== "boolean") fail("INVALID_RAW_OBSERVATION", "is_open must be boolean");
  for (const field of RAW_OPTIONAL_STRING_FIELDS) {
    if (Object.hasOwn(raw, field) && typeof raw[field] !== "string") {
      fail("INVALID_RAW_OBSERVATION", `${field} must be a string when provided`);
    }
  }
  if (Object.hasOwn(raw, "snapshot_park_date") && !isCalendarDate(raw.snapshot_park_date)) {
    fail("INVALID_RAW_OBSERVATION", "snapshot_park_date must be a valid YYYY-MM-DD date when provided");
  }
  if (Object.hasOwn(raw, "wait_time_minutes") && raw.wait_time_minutes !== null &&
      (!Number.isInteger(raw.wait_time_minutes) || raw.wait_time_minutes < 0)) {
    fail("INVALID_WAIT", "raw v1 wait_time_minutes must be null or a non-negative integer");
  }
  if (typeof raw.source_url !== "string" || raw.source_url.length === 0) {
    fail("INVALID_RAW_OBSERVATION", "source_url is required by raw-wait-observation.v1");
  }
}

function validateArchiveLineReference(reference) {
  if (!reference || typeof reference !== "object" || Array.isArray(reference) ||
      reference.contract_version !== "raw-archive-line-reference.v1") {
    fail("INVALID_ARCHIVE_LINE_REFERENCE", "raw-archive-line-reference.v1 is required");
  }
  const unexpectedFields = Object.keys(reference).filter((field) => !ARCHIVE_LINE_REFERENCE_FIELDS.has(field));
  if (unexpectedFields.length > 0) {
    fail("INVALID_ARCHIVE_LINE_REFERENCE", `raw-archive-line-reference.v1 does not allow ${unexpectedFields.join(", ")}`);
  }
  if (!SHA256.test(reference.raw_observation_id || "") ||
      !SHA256.test(reference.raw_archive_id || "") ||
      !SHA256.test(reference.archive_sha256 || "")) {
    fail("INVALID_ARCHIVE_LINE_REFERENCE", "archive-line IDs and hash must be SHA-256 hex values");
  }
  if (!Number.isInteger(reference.source_line_number) || reference.source_line_number < 1) {
    fail("INVALID_ARCHIVE_LINE_REFERENCE", "source_line_number must be a one-based data-row ordinal");
  }
  if (typeof reference.r2_uri !== "string" || !/^s3:\/\/[^/]+\/.+/.test(reference.r2_uri) ||
      !Number.isInteger(reference.archive_byte_size) || reference.archive_byte_size < 1 ||
      typeof reference.source_name !== "string" || reference.source_name.length === 0 ||
      typeof reference.archive_schema_version !== "string" || reference.archive_schema_version.length === 0) {
    fail("INVALID_ARCHIVE_LINE_REFERENCE", "archive-line reference metadata is incomplete");
  }
}

function calculateRawObservationId(archiveSha256, oneBasedDataRowOrdinal) {
  return sha256(`${archiveSha256}:${oneBasedDataRowOrdinal}`);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseInstant(value, field) {
  if (typeof value !== "string") fail("INVALID_TIMESTAMP", `${field} must be a timezone-qualified date-time`);
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match || !isCalendarDate(match[1]) ||
      Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59 ||
      (match[6] && (Number(match[6]) > 23 || Number(match[7]) > 59))) {
    fail("INVALID_TIMESTAMP", `${field} must be a valid timezone-qualified date-time`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) fail("INVALID_TIMESTAMP", `${field} is invalid`);
  return parsed;
}

function parseUtcOutputTime(value, field) {
  const parsed = parseInstant(value, field);
  if (!value.endsWith("Z")) fail("INVALID_TIMESTAMP", `${field} must be UTC with a Z suffix`);
  return parsed.toISOString();
}

function validateTimezone(value, field) {
  if (typeof value !== "string" || value.length === 0) fail("INVALID_TIMEZONE", `${field} is required`);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    fail("INVALID_TIMEZONE", `${field} is not a valid IANA timezone`);
  }
  return value;
}

function parkLocalDate(instant, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseNullableWait(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 0) {
    fail("INVALID_WAIT", "raw v1 wait_time_minutes must be null or a non-negative integer");
  }
  return value;
}

function isCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function determineTrainingEligibility({ attraction, accessMode, isOpen, waitTimeMinutes, isStale }) {
  if (["refurbishment", "retired"].includes(attraction.operational_state) ||
      attraction.training_disposition === "ineligible_lifecycle") return "ineligible_lifecycle";
  if (attraction.operational_state === "unknown" || attraction.training_disposition === "review_required") {
    return "review_required";
  }
  if (attraction.wait_capability !== "posted_standby" || attraction.training_disposition === "ineligible_no_wait") {
    return "ineligible_no_wait";
  }
  if (attraction.training_disposition !== "eligible") return attraction.training_disposition;
  if (accessMode !== "standby") return "exclude_non_standby_access_mode";
  if (!isOpen) return "status_model_only";
  if (waitTimeMinutes === null) return "exclude_missing_wait";
  if (isStale) return "exclude_stale_source";
  return "standby_wait_model";
}

function fail(code, message) {
  throw new ArchivedObservationNormalizationError(code, message);
}
