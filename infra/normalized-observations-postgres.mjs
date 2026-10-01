import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
const ACCESS_MODES = new Set(["standby", "single_rider", "virtual_queue", "other"]);
const CATEGORIES = new Set(["attraction", "entertainment"]);
const NORMALIZED_FIELDS = [
  "normalized_observation_id",
  "contract_version",
  "raw_observation_id",
  "operator_id",
  "resort_id",
  "park_id",
  "park_timezone",
  "observed_at_utc",
  "canonical_attraction_id",
  "canonical_attraction_name",
  "canonical_category",
  "canonical_match_source",
  "access_mode",
  "is_open",
  "observed_wait_time_minutes",
  "quality_flags",
  "training_eligibility",
  "transformation_version",
  "generated_at"
];
const NORMALIZED_FIELD_SET = new Set(NORMALIZED_FIELDS);
const SEMANTIC_FIELDS = NORMALIZED_FIELDS.filter((field) => field !== "generated_at");
const ACTIVE_STORAGE_TRANSACTION_TOKENS = new WeakMap();

export class NormalizedObservationConflictError extends Error {
  constructor(normalizedObservationId) {
    super(`Normalized observation ${normalizedObservationId} has a conflicting immutable semantic payload.`);
    this.name = "NormalizedObservationConflictError";
    this.code = "NORMALIZED_OBSERVATION_CONFLICT";
  }
}

/**
 * Execute a composed hosted write on one checked-out client. Repositories created
 * inside the callback are transaction-bound and must not start or commit transactions.
 */
export async function withPostgresStorageTransaction(pool, operation) {
  if (!pool || typeof pool.connect !== "function") throw new TypeError("pool must expose connect()");
  if (typeof operation !== "function") throw new TypeError("operation must be a function");
  const client = await pool.connect();
  let transactionOpen = false;
  let beginAttempted = false;
  let commitAttempted = false;
  let releaseError = null;
  let transactionToken = null;
  try {
    beginAttempted = true;
    await client.query("BEGIN");
    transactionOpen = true;
    transactionToken = Object.freeze({});
    ACTIVE_STORAGE_TRANSACTION_TOKENS.set(client, transactionToken);
    const result = await operation(client);
    deactivateStorageTransaction(client, transactionToken);
    commitAttempted = true;
    await client.query("COMMIT");
    transactionOpen = false;
    return result;
  } catch (error) {
    deactivateStorageTransaction(client, transactionToken);
    let errorToThrow = error;
    if (transactionOpen && !commitAttempted) {
      try {
        await client.query("ROLLBACK");
        transactionOpen = false;
      } catch (rollbackError) {
        errorToThrow = attachSecondaryError(error, "rollbackError", rollbackError);
        releaseError = rollbackError;
      }
    } else if (beginAttempted) {
      // BEGIN or COMMIT outcome is unknown; do not return this client to the pool.
      releaseError = error;
    }
    throw errorToThrow;
  } finally {
    deactivateStorageTransaction(client, transactionToken);
    if (releaseError) client.release?.(releaseError);
    else client.release?.();
  }
}

/** Persistence port for normalized v2; client must belong to the caller's active transaction. */
export function createPostgresNormalizedObservationRepository(client) {
  const transactionToken = assertCallerTransactionClient(client);

  return {
    async putNormalizedObservation(record) {
      assertCallerTransactionClient(client, transactionToken);
      validateNormalizedRecord(record);
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`normalized-observation:${record.normalized_observation_id}`]
      );
      const comparisonValues = [
        record.normalized_observation_id,
        ...SEMANTIC_FIELDS.map((field) => record[field])
      ];
      const result = await client.query(
        `SELECT (${SEMANTIC_FIELDS.map((field, index) =>
          `${field} IS NOT DISTINCT FROM $${index + 2}${fieldCast(field)}`).join(" AND ")
        }) AS same_semantic_payload,
        generated_at
           FROM observations.normalized_wait_observations_v2
          WHERE normalized_observation_id = $1
          FOR UPDATE`,
        comparisonValues
      );

      if (result.rows.length > 0) {
        if (result.rows[0].same_semantic_payload !== true) {
          throw new NormalizedObservationConflictError(record.normalized_observation_id);
        }
        return { ...record, generated_at: asUtcIso(result.rows[0].generated_at) };
      }

      const values = NORMALIZED_FIELDS.map((field) => record[field]);
      const inserted = await client.query(
        `INSERT INTO observations.normalized_wait_observations_v2 (${NORMALIZED_FIELDS.join(", ")})
         VALUES (${NORMALIZED_FIELDS.map((_, index) => `$${index + 1}`).join(", ")})
         RETURNING generated_at`,
        values
      );
      if (inserted.rows.length !== 1) {
        throw new Error("Normalized observation insert did not return its persisted generated_at.");
      }
      return { ...record, generated_at: asUtcIso(inserted.rows[0].generated_at) };
    }
  };
}

/** Shared guard for the 04d3 repositories; repositories capture a unique transaction token. */
export function assertCallerTransactionClient(client, expectedToken) {
  if (!client || typeof client.query !== "function") throw new TypeError("client must expose query()");
  const activeToken = ACTIVE_STORAGE_TRANSACTION_TOKENS.get(client);
  if (!activeToken || (expectedToken !== undefined && activeToken !== expectedToken)) {
    throw new TypeError("04d3 repositories require the client provided inside withPostgresStorageTransaction().");
  }
  return activeToken;
}

function deactivateStorageTransaction(client, transactionToken) {
  if (transactionToken && ACTIVE_STORAGE_TRANSACTION_TOKENS.get(client) === transactionToken) {
    ACTIVE_STORAGE_TRANSACTION_TOKENS.delete(client);
  }
}

export function calculateNormalizedObservationId(rawObservationId, transformationVersion) {
  if (typeof rawObservationId !== "string" || !SHA256.test(rawObservationId) ||
      !isNonEmptyString(transformationVersion)) {
    throw new TypeError("rawObservationId and transformationVersion are required to calculate the normalized key.");
  }
  return createHash("sha256")
    .update(`${rawObservationId}:${transformationVersion}`, "utf8")
    .digest("hex");
}

function validateNormalizedRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError("normalized-wait-observation.v2 must be an object.");
  }
  if (Reflect.ownKeys(record).some((field) => typeof field !== "string" || !NORMALIZED_FIELD_SET.has(field)) ||
      NORMALIZED_FIELDS.some((field) => !Object.hasOwn(record, field))) {
    throw new TypeError("normalized-wait-observation.v2 must contain exactly its declared fields.");
  }
  if (record.contract_version !== "normalized-wait-observation.v2" ||
      !SHA256.test(record.normalized_observation_id) || !SHA256.test(record.raw_observation_id) ||
      record.normalized_observation_id !== calculateNormalizedObservationId(
        record.raw_observation_id,
        record.transformation_version
      )) {
    throw new TypeError("normalized v2 contract version or deterministic lineage key is invalid.");
  }
  for (const field of [
    "operator_id",
    "resort_id",
    "park_id",
    "canonical_attraction_id",
    "canonical_attraction_name",
    "canonical_match_source",
    "training_eligibility",
    "transformation_version"
  ]) {
    if (!isNonEmptyString(record[field])) throw new TypeError(`${field} must be a non-empty string.`);
  }
  if (!isIanaTimezone(record.park_timezone)) throw new TypeError("park_timezone must be a valid IANA time zone.");
  if (!isUtcDateTime(record.observed_at_utc) || !isUtcDateTime(record.generated_at)) {
    throw new TypeError("observed_at_utc and generated_at must be valid UTC date-times ending in Z.");
  }
  if (!CATEGORIES.has(record.canonical_category) || !ACCESS_MODES.has(record.access_mode)) {
    throw new TypeError("canonical_category or access_mode is unsupported.");
  }
  if (typeof record.is_open !== "boolean") throw new TypeError("is_open must be boolean.");
  if (record.observed_wait_time_minutes !== null &&
      (typeof record.observed_wait_time_minutes !== "number" ||
       !Number.isFinite(record.observed_wait_time_minutes) || record.observed_wait_time_minutes < 0)) {
    throw new TypeError("observed_wait_time_minutes must be null or a non-negative finite number.");
  }
  if (!record.is_open && record.observed_wait_time_minutes !== null) {
    throw new TypeError("closed normalized observations must have a null wait.");
  }
  if (!Array.isArray(record.quality_flags) ||
      record.quality_flags.some((flag) => !isNonEmptyString(flag)) ||
      new Set(record.quality_flags).size !== record.quality_flags.length) {
    throw new TypeError("quality_flags must contain unique non-empty strings.");
  }
}

function fieldCast(field) {
  if (field === "observed_at_utc") return "::timestamptz";
  if (field === "observed_wait_time_minutes") return "::numeric";
  if (field === "quality_flags") return "::text[]";
  return "";
}

function isUtcDateTime(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return false;
  const calendarDate = new Date(`${match[1]}T00:00:00.000Z`);
  return !Number.isNaN(calendarDate.getTime()) &&
    calendarDate.toISOString().slice(0, 10) === match[1] &&
    !Number.isNaN(Date.parse(value));
}

function isIanaTimezone(value) {
  if (!isNonEmptyString(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function asUtcIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("Persisted generated_at is not a valid timestamp.");
  return date.toISOString();
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function attachSecondaryError(primaryError, property, secondaryError) {
  if (primaryError && typeof primaryError === "object") {
    try {
      Object.defineProperty(primaryError, property, {
        configurable: true,
        value: secondaryError
      });
      return primaryError;
    } catch {
      // Fall through to an aggregate that retains both errors.
    }
  }
  return new AggregateError(
    [primaryError, secondaryError],
    "Storage operation and transaction rollback both failed.",
    { cause: primaryError }
  );
}
