import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBackfillPlan } from "../infra/backfill/wait-time-records.mjs";
import {
  buildReplayParityReport,
  loadDatabaseSnapshot,
  loadOperatingWindows
} from "./report-replay-parity.mjs";

export const hostedBackfillContractVersion = "hosted-backfill-report.v1";
const expectedTargetLabel = "neon-validation-branch-only";

/**
 * Build an evidence report from already loaded Git, PostgreSQL and object-store
 * snapshots. This function is pure so classification remains testable without
 * credentials, a database, or a network connection.
 */
export function buildHostedBackfillReport({
  plan,
  neon = { archives: [], rawCounts: new Map(), normalizedCounts: new Map() },
  r2 = { objects: [] },
  replayParity,
  root,
  bucket,
  targetLabel,
  generatedAt = new Date().toISOString(),
  runId = randomUUID(),
  databaseError = null,
  objectStorageError = null
}) {
  const rawArchiveByObservationId = new Map((plan.rawRecords || []).map((row) => [row.rawObservationId, row.rawArchiveId]));
  const expectedArchives = plan.archives.map((archive) => ({
    raw_archive_id: archive.rawArchiveId,
    sha256: archive.sha256,
    source_name: archive.sourceName,
    path: root ? path.relative(root, archive.filePath).replaceAll(path.sep, "/") : archive.filePath,
    date: archive.sourceName.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || null,
    byte_size: archive.byteSize,
    row_count: plan.rawRecords.filter((row) => row.rawArchiveId === archive.rawArchiveId).length,
    normalized_row_count: plan.normalizedRecords.filter((row) => rawArchiveByObservationId.get(row.rawObservationId) === archive.rawArchiveId).length
  }));
  const expectedIds = new Set(expectedArchives.map((archive) => archive.raw_archive_id));
  const expectedKeys = new Set(expectedArchives.map((archive) => objectKey(archive, bucket)));
  const neonById = new Map((neon.archives || []).map((archive) => [String(archive.raw_archive_id), archive]));
  const neonBySourceName = new Map((neon.archives || []).map((archive) => [String(archive.source_name), archive]));
  const r2Objects = r2.objects || [];
  const r2ByKey = new Map(r2Objects.map((object) => [String(object.key), object]));
  const r2BySourceName = new Map(r2Objects
    .map((object) => [object.source_name, object])
    .filter(([sourceName]) => sourceName));

  const archives = expectedArchives.map((gitArchive) => {
    const neonArchive = neonById.get(gitArchive.raw_archive_id) || neonBySourceName.get(gitArchive.source_name) || null;
    const expectedKey = objectKey(gitArchive, bucket);
    const r2Object = r2ByKey.get(expectedKey) || r2BySourceName.get(gitArchive.source_name) || null;
    const neonObservationCount = numberOrNull(neon.rawCounts?.get(gitArchive.raw_archive_id));
    const neonNormalizedCount = numberOrNull(neon.normalizedCounts?.get(gitArchive.raw_archive_id));
    const neonIssues = [];
    if (!neonArchive) {
      neonIssues.push("missing_archive");
    } else {
      if (String(neonArchive.raw_archive_id) !== gitArchive.raw_archive_id) neonIssues.push("archive_id_mismatch");
      if (String(neonArchive.sha256) !== gitArchive.sha256) neonIssues.push("sha256_mismatch");
      if (numberOrNull(neonArchive.byte_size) !== gitArchive.byte_size) neonIssues.push("byte_size_mismatch");
      if (String(neonArchive.source_name) !== gitArchive.source_name) neonIssues.push("source_name_mismatch");
      if (neonObservationCount !== gitArchive.row_count) neonIssues.push("raw_row_count_mismatch");
      if (neonNormalizedCount !== gitArchive.normalized_row_count) neonIssues.push("normalized_row_count_mismatch");
    }

    const r2Issues = [];
    if (!r2Object) {
      r2Issues.push("missing_object");
    } else {
      if (String(r2Object.key) !== expectedKey) r2Issues.push("key_mismatch");
      if (numberOrNull(r2Object.size) !== gitArchive.byte_size) r2Issues.push("byte_size_mismatch");
      if (r2Object.verification_error) r2Issues.push("verification_error");
      if (r2Object.metadata_sha256 && String(r2Object.metadata_sha256) !== gitArchive.sha256) r2Issues.push("metadata_sha256_mismatch");
      if (r2Object.content_sha256 && String(r2Object.content_sha256) !== gitArchive.sha256) r2Issues.push("content_sha256_mismatch");
      if (r2Object.head_content_length !== undefined && numberOrNull(r2Object.head_content_length) !== gitArchive.byte_size) {
        r2Issues.push("head_byte_size_mismatch");
      }
    }

    const hashMismatch = neonIssues.some((issue) => issue.includes("sha256") || issue === "archive_id_mismatch")
      || r2Issues.some((issue) => issue.includes("sha256"));
    const countMismatch = neonIssues.some((issue) => issue.includes("count"));
    let classification;
    if (!neonArchive && !r2Object) classification = "git_only";
    else if (r2Object?.verification_error) classification = "r2_error";
    else if (hashMismatch) classification = "hash_mismatch";
    else if (!neonArchive) classification = "r2_only";
    else if (!r2Object) classification = "neon_only";
    else if (countMismatch || neonIssues.length || r2Issues.length) classification = "count_mismatch";
    else classification = "matched";

    return {
      ...gitArchive,
      expected_object_key: expectedKey,
      classification,
      issues: [...new Set([...neonIssues.map((issue) => `neon:${issue}`), ...r2Issues.map((issue) => `r2:${issue}`)])],
      neon: neonArchive ? {
        raw_archive_id: String(neonArchive.raw_archive_id),
        sha256: String(neonArchive.sha256),
        byte_size: numberOrNull(neonArchive.byte_size),
        source_name: String(neonArchive.source_name),
        object_uri: neonArchive.object_uri || null,
        raw_observation_count: neonObservationCount,
        normalized_observation_count: neonNormalizedCount
      } : null,
      r2: r2Object ? {
        key: String(r2Object.key),
        listed_byte_size: numberOrNull(r2Object.size),
        head_byte_size: numberOrNull(r2Object.head_content_length),
        metadata_sha256: r2Object.metadata_sha256 || null,
        content_sha256: r2Object.content_sha256 || null,
        etag: r2Object.etag || null,
        verification_error: r2Object.verification_error || null
      } : null
    };
  });

  const neonOnly = (neon.archives || [])
    .filter((archive) => !expectedIds.has(String(archive.raw_archive_id)))
    .map((archive) => ({
      raw_archive_id: String(archive.raw_archive_id),
      sha256: String(archive.sha256),
      source_name: String(archive.source_name),
      byte_size: numberOrNull(archive.byte_size),
      object_uri: archive.object_uri || null,
      raw_observation_count: numberOrNull(neon.rawCounts?.get(String(archive.raw_archive_id))),
      normalized_observation_count: numberOrNull(neon.normalizedCounts?.get(String(archive.raw_archive_id)))
    }));
  const r2Only = r2Objects
    .filter((object) => !expectedKeys.has(String(object.key)))
    .map((object) => ({
      key: String(object.key),
      source_name: object.source_name || null,
      key_sha256: object.sha256 || null,
      listed_byte_size: numberOrNull(object.size),
      etag: object.etag || null
    }));

  const classificationCounts = {
    matched: archives.filter((archive) => archive.classification === "matched").length,
    git_only: archives.filter((archive) => archive.classification === "git_only").length,
    neon_only: archives.filter((archive) => archive.classification === "neon_only").length + neonOnly.length,
    r2_only: archives.filter((archive) => archive.classification === "r2_only").length + r2Only.length,
    hash_mismatch: archives.filter((archive) => archive.classification === "hash_mismatch").length,
    count_mismatch: archives.filter((archive) => archive.classification === "count_mismatch").length,
    r2_error: archives.filter((archive) => archive.classification === "r2_error").length
  };

  const failures = [];
  if (targetLabel !== expectedTargetLabel) {
    failures.push({ type: "target_confirmation_missing", expected: expectedTargetLabel, actual: targetLabel || null });
  }
  if (databaseError) failures.push({ type: "database_unavailable", detail: sanitizeError(databaseError) });
  if (objectStorageError) failures.push({ type: "object_storage_unavailable", detail: sanitizeError(objectStorageError) });
  for (const archive of archives.filter((entry) => entry.classification !== "matched")) {
    failures.push({ type: archive.classification, source_name: archive.source_name, issues: archive.issues });
  }
  if (neonOnly.length) failures.push({ type: "neon_only", count: neonOnly.length, source_names: neonOnly.map((archive) => archive.source_name) });
  if (r2Only.length) failures.push({ type: "r2_only", count: r2Only.length, keys: r2Only.map((object) => object.key) });
  if (!replayParity || replayParity.status !== "passed") {
    failures.push({ type: "replay_parity_blocked", detail: replayParity?.failures?.slice(0, 20) || [] });
  }
  const complete = !failures.length && archives.every((archive) => archive.classification === "matched");

  return {
    contract_version: hostedBackfillContractVersion,
    run_id: runId,
    generated_at: generatedAt,
    status: complete ? "passed" : "blocked",
    complete,
    scope: {
      root_scope: "data/wait_times/*.csv",
      target_label: targetLabel || null,
      bucket: bucket || null,
      object_prefix: "wait-times/"
    },
    counts: {
      git_archives: expectedArchives.length,
      git_raw_observations: plan.rawRecords.length,
      git_normalized_observations: plan.normalizedRecords.length,
      neon_archives: (neon.archives || []).length,
      r2_objects: r2Objects.length,
      matched_archives: classificationCounts.matched
    },
    classification_counts: classificationCounts,
    archives,
    neon_only: neonOnly,
    r2_only: r2Only,
    replay_parity: replayParity || null,
    failures,
    next_steps: complete
      ? [
          "Retain this report and its input plan as the hosted validation checkpoint.",
          "Keep GitHub Actions and Git fallback enabled until production cutover and rollback gates are separately accepted.",
          "Do not delete the local dataset until this report, the backup/restore gate, and the retention decision are accepted."
        ]
      : [
          "Do not delete local data or use this target for production cutover.",
          "Resolve every Git/Neon/R2 classification and rerun the read-only report.",
          "Keep GitHub Actions and Git fallback enabled while hosted storage is incomplete."
        ]
  };
}

export function objectKey(archive, bucket) {
  return `wait-times/${archive.sha256}/${archive.source_name}`;
}

async function loadNeonState(client, plan) {
  const archiveResult = await client.query(
    `SELECT raw_archive_id::text AS raw_archive_id, sha256::text AS sha256,
            byte_size::int AS byte_size, source_name, object_uri
       FROM ingestion.raw_archives
      ORDER BY source_name, raw_archive_id`
  );
  const rawResult = await client.query(
    `SELECT raw_archive_id::text AS raw_archive_id, count(*)::int AS count
       FROM ingestion.raw_wait_observations
      GROUP BY raw_archive_id`
  );
  const normalizedResult = await client.query(
    `SELECT raw.raw_archive_id::text AS raw_archive_id, count(*)::int AS count
       FROM observations.normalized_wait_observations AS normalized
       JOIN ingestion.raw_wait_observations AS raw USING (raw_observation_id)
      GROUP BY raw.raw_archive_id`
  );
  const databaseSnapshot = await loadDatabaseSnapshot(client, {
    archiveIds: plan.archives.map((archive) => archive.rawArchiveId),
    transformationVersions: [...new Set(plan.normalizedRecords.map((row) => row.transformationVersion))]
  });
  return {
    archives: archiveResult.rows || [],
    rawCounts: new Map((rawResult.rows || []).map((row) => [String(row.raw_archive_id), Number(row.count)])),
    normalizedCounts: new Map((normalizedResult.rows || []).map((row) => [String(row.raw_archive_id), Number(row.count)])),
    databaseSnapshot
  };
}

async function loadR2State() {
  const bucket = process.env.RAW_ARCHIVE_BUCKET;
  if (!bucket) throw new Error("RAW_ARCHIVE_BUCKET is required for hosted archive audit");
  const { S3Client, ListObjectsV2Command, HeadObjectCommand, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region: process.env.AWS_REGION || "us-west-2",
    endpoint: process.env.RAW_ARCHIVE_ENDPOINT || undefined,
    forcePathStyle: Boolean(process.env.RAW_ARCHIVE_ENDPOINT)
  });
  const listed = [];
  let continuationToken;
  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: "wait-times/",
      ContinuationToken: continuationToken
    }));
    for (const object of response.Contents || []) {
      const parsed = parseObjectKey(object.Key);
      listed.push({
        key: object.Key,
        sha256: parsed?.sha256 || null,
        source_name: parsed?.sourceName || null,
        size: Number(object.Size),
        etag: object.ETag || null,
        last_modified: object.LastModified?.toISOString?.() || null
      });
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  for (const object of listed) {
    if (!object.key || !object.source_name) continue;
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: object.key }));
      const metadata = Object.fromEntries(Object.entries(head.Metadata || {}).map(([key, value]) => [key.toLowerCase(), value]));
      const content = await client.send(new GetObjectCommand({ Bucket: bucket, Key: object.key }));
      object.head_content_length = Number(head.ContentLength);
      object.metadata_sha256 = metadata.sha256 || null;
      object.schema_version = metadata.schema_version || null;
      object.content_sha256 = await hashResponseBody(content.Body);
    } catch (error) {
      object.verification_error = sanitizeError(error.message || error);
    }
  }
  return { objects: listed };
}

function parseObjectKey(key) {
  const prefix = "wait-times/";
  if (typeof key !== "string" || !key.startsWith(prefix)) return null;
  const remainder = key.slice(prefix.length);
  const separator = remainder.indexOf("/");
  if (separator <= 0 || separator === remainder.length - 1) return null;
  return { sha256: remainder.slice(0, separator), sourceName: remainder.slice(separator + 1) };
}

async function hashResponseBody(body) {
  if (!body) throw new Error("object response did not contain a body");
  const digest = createHash("sha256");
  if (typeof body.transformToByteArray === "function") {
    digest.update(await body.transformToByteArray());
  } else if (body[Symbol.asyncIterator]) {
    for await (const chunk of body) digest.update(chunk);
  } else {
    throw new Error("object response body is not readable");
  }
  return digest.digest("hex");
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sanitizeError(error) {
  return String(error || "unknown error")
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-database-url]")
    .replace(/(AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|secret|token|password)=\S+/gi, "$1=[redacted]");
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const date = process.argv.find((argument) => argument.startsWith("--date="))?.slice("--date=".length) || undefined;
  const generatedAt = new Date().toISOString();
  const runId = `hosted-backfill-${randomUUID()}`;
  const plan = await buildBackfillPlan(root, { date, generatedAt });
  const targetLabel = process.env.HOSTED_TARGET_LABEL || null;
  let neon = { archives: [], rawCounts: new Map(), normalizedCounts: new Map(), databaseSnapshot: null };
  let databaseError = null;
  if (!process.env.DATABASE_URL) {
    databaseError = "DATABASE_URL is required for hosted archive audit";
  } else {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const client = await pool.connect();
      try {
        await client.query("BEGIN TRANSACTION READ ONLY");
        try {
          neon = await loadNeonState(client, plan);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          databaseError = error.message;
        }
      } finally {
        client.release();
      }
    } catch (error) {
      databaseError = error.message;
    } finally {
      await pool.end();
    }
  }

  let r2 = { objects: [] };
  let objectStorageError = null;
  try {
    r2 = await loadR2State();
  } catch (error) {
    objectStorageError = error.message;
  }

  const windows = await loadOperatingWindows(root, { date });
  const replayParity = buildReplayParityReport({
    plan,
    databaseSnapshot: neon.databaseSnapshot,
    operatingWindows: windows,
    generatedAt,
    runId,
    databaseError
  });
  const report = buildHostedBackfillReport({
    plan,
    neon,
    r2,
    replayParity,
    root,
    bucket: process.env.RAW_ARCHIVE_BUCKET,
    targetLabel,
    generatedAt,
    runId,
    databaseError,
    objectStorageError
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "passed") process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(sanitizeError(error.message || error));
    process.exitCode = 1;
  });
}
