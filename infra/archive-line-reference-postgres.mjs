import { createHash } from "node:crypto";
import { assertCallerTransactionClient } from "./normalized-observations-postgres.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const REFERENCE_FIELDS = [
  "contract_version",
  "raw_observation_id",
  "raw_archive_id",
  "r2_uri",
  "archive_sha256",
  "archive_byte_size",
  "source_line_number",
  "source_name",
  "archive_schema_version"
];
const REFERENCE_FIELD_SET = new Set(REFERENCE_FIELDS);

export class ArchiveLineReferenceConflictError extends Error {
  constructor(rawObservationId) {
    super(`Archive-line reference ${rawObservationId} conflicts with an immutable persisted reference.`);
    this.name = "ArchiveLineReferenceConflictError";
    this.code = "ARCHIVE_LINE_REFERENCE_CONFLICT";
  }
}

/** Persistence port for reference-only R2 lineage; it never stores raw observation payloads. */
export function createPostgresArchiveLineReferenceRepository(client) {
  const transactionToken = assertCallerTransactionClient(client);

  return {
    async putArchiveLineReference(reference) {
      assertCallerTransactionClient(client, transactionToken);
      validateReference(reference);
      await lockKey(client, `archive-line:${reference.raw_observation_id}`);
      const existing = await client.query(
        `SELECT ${REFERENCE_FIELDS.join(", ")}
           FROM ingestion.raw_archive_line_references
          WHERE raw_observation_id = $1
          FOR UPDATE`,
        [reference.raw_observation_id]
      );
      if (existing.rows.length > 0) {
        const persisted = normalizeReferenceRow(existing.rows[0]);
        if (!referenceEquals(persisted, reference)) {
          throw new ArchiveLineReferenceConflictError(reference.raw_observation_id);
        }
        return persisted;
      }

      await client.query(
        `INSERT INTO ingestion.raw_archive_line_references (${REFERENCE_FIELDS.join(", ")})
         VALUES (${REFERENCE_FIELDS.map((_, index) => `$${index + 1}`).join(", ")})`,
        REFERENCE_FIELDS.map((field) => reference[field])
      );
      return { ...reference };
    },

    async getArchiveLineReference(rawObservationId) {
      assertCallerTransactionClient(client, transactionToken);
      if (typeof rawObservationId !== "string" || !SHA256.test(rawObservationId)) {
        throw new TypeError("rawObservationId must be a lowercase SHA-256 hex value.");
      }
      const result = await client.query(
        `SELECT ${REFERENCE_FIELDS.join(", ")}
           FROM ingestion.raw_archive_line_references
          WHERE raw_observation_id = $1`,
        [rawObservationId]
      );
      return result.rows.length === 0 ? null : normalizeReferenceRow(result.rows[0]);
    }
  };
}

export function calculateRawObservationId(archiveSha256, oneBasedDataRowOrdinal) {
  if (typeof archiveSha256 !== "string" || !SHA256.test(archiveSha256) ||
      !Number.isSafeInteger(oneBasedDataRowOrdinal) || oneBasedDataRowOrdinal < 1) {
    throw new TypeError("archiveSha256 and a positive one-based data-row ordinal are required.");
  }
  return createHash("sha256")
    .update(`${archiveSha256}:${oneBasedDataRowOrdinal}`, "utf8")
    .digest("hex");
}

function validateReference(reference) {
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
    throw new TypeError("raw-archive-line-reference.v1 must be an object.");
  }
  if (Reflect.ownKeys(reference).some((field) => typeof field !== "string" || !REFERENCE_FIELD_SET.has(field)) ||
      REFERENCE_FIELDS.some((field) => !Object.hasOwn(reference, field))) {
    throw new TypeError("raw-archive-line-reference.v1 must contain exactly its declared fields.");
  }
  if (reference.contract_version !== "raw-archive-line-reference.v1" ||
      !SHA256.test(reference.raw_observation_id) || !SHA256.test(reference.raw_archive_id) ||
      !SHA256.test(reference.archive_sha256)) {
    throw new TypeError("raw-archive-line-reference.v1 versions and SHA-256 identities are required.");
  }
  if (!Number.isSafeInteger(reference.archive_byte_size) || reference.archive_byte_size < 1 ||
      !Number.isSafeInteger(reference.source_line_number) || reference.source_line_number < 1 ||
      !isNonEmptyString(reference.source_name) || !isNonEmptyString(reference.archive_schema_version)) {
    throw new TypeError("archive byte size, one-based line ordinal, source name, and schema version are required.");
  }
  if (!isR2Uri(reference.r2_uri)) {
    throw new TypeError("r2_uri must be an s3://bucket/object URI without credentials or query data.");
  }
  const expectedId = calculateRawObservationId(reference.archive_sha256, reference.source_line_number);
  if (reference.raw_observation_id !== expectedId) {
    throw new TypeError("raw_observation_id does not match SHA-256(archive_sha256:source_line_number).");
  }
}

function isR2Uri(value) {
  if (typeof value !== "string" || !/^s3:\/\/[^/]+\/.+/.test(value)) return false;
  try {
    const uri = new URL(value);
    return uri.protocol === "s3:" && Boolean(uri.hostname) && !uri.username && !uri.password && !uri.search && !uri.hash;
  } catch {
    return false;
  }
}

function normalizeReferenceRow(row) {
  return {
    contract_version: row.contract_version,
    raw_observation_id: String(row.raw_observation_id).trim(),
    raw_archive_id: String(row.raw_archive_id).trim(),
    r2_uri: row.r2_uri,
    archive_sha256: String(row.archive_sha256).trim(),
    archive_byte_size: Number(row.archive_byte_size),
    source_line_number: Number(row.source_line_number),
    source_name: row.source_name,
    archive_schema_version: row.archive_schema_version
  };
}

function referenceEquals(left, right) {
  return REFERENCE_FIELDS.every((field) => left[field] === right[field]);
}

async function lockKey(client, key) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
