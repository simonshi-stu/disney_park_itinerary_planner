import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBackfillPlan, rawSchemaVersion } from "../infra/backfill/wait-time-records.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const date = process.argv.find((arg) => arg.startsWith("--date="))?.slice("--date=".length);
const checkOnly = args.has("--check");
const skipUpload = args.has("--skip-upload");
const generatedAt = new Date().toISOString();
const plan = await buildBackfillPlan(root, { date, generatedAt });

if (checkOnly) {
  console.log(JSON.stringify(plan.report, null, 2));
  process.exit(0);
}

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required unless --check is used");
const objectUris = skipUpload ? assumedObjectUris(plan.archives) : await uploadArchives(plan.archives);
const { default: pg } = await import("pg");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

try {
  const migration = await readFile(path.join(root, "infra", "migrations", "0001_observation_storage.sql"), "utf8");
  await pool.query(migration);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await persistPlan(client, plan, objectUris);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const verification = await verifyDatabase(pool, plan);
  console.log(JSON.stringify({ ...plan.report, database: "persisted", rawArchives: objectUris.size, verification }, null, 2));
} finally {
  await pool.end();
}

async function uploadArchives(archives) {
  const bucket = process.env.RAW_ARCHIVE_BUCKET;
  if (!bucket) throw new Error("RAW_ARCHIVE_BUCKET is required for immutable raw upload");
  const { S3Client, PutObjectCommand, HeadBucketCommand, CreateBucketCommand } = await import("@aws-sdk/client-s3");
  const region = process.env.AWS_REGION || "us-west-2";
  const client = new S3Client({
    region,
    endpoint: process.env.RAW_ARCHIVE_ENDPOINT || undefined,
    forcePathStyle: Boolean(process.env.RAW_ARCHIVE_ENDPOINT)
  });
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    const createBucket = region === "us-east-1" ? { Bucket: bucket } : { Bucket: bucket, CreateBucketConfiguration: { LocationConstraint: region } };
    await client.send(new CreateBucketCommand(createBucket));
  }
  const uris = new Map();
  for (const archive of archives) {
    const key = `wait-times/${archive.sha256}/${archive.sourceName}`;
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: archive.content,
      ContentType: "text/csv; charset=utf-8",
      Metadata: { sha256: archive.sha256, schema_version: rawSchemaVersion }
    }));
    uris.set(archive.rawArchiveId, `s3://${bucket}/${key}`);
  }
  return uris;
}

function assumedObjectUris(archives) {
  const base = process.env.RAW_ARCHIVE_BASE_URI;
  if (!base || !/^(s3|gs|az):\/\//.test(base)) {
    throw new Error("RAW_ARCHIVE_BASE_URI with s3://, gs://, or az:// is required with --skip-upload");
  }
  return new Map(archives.map((archive) => [archive.rawArchiveId, `${base.replace(/\/$/, "")}/wait-times/${archive.sha256}/${archive.sourceName}`]));
}

async function persistPlan(client, plan, objectUris) {
  const parks = uniqueBy(plan.rawRecords.map((row) => [row.parkId, row.parkName, row.snapshotTimezone]), (row) => row[0]);
  await insertRows(client, "catalog.parks", ["park_id", "park_name", "timezone"], parks);

  const parkByRawObservationId = new Map(plan.rawRecords.map((row) => [row.rawObservationId, row.parkId]));
  const attractions = uniqueBy([
    ...plan.normalizedRecords.map((row) => [row.canonicalAttractionId, parkByRawObservationId.get(row.rawObservationId), row.canonicalAttractionName, row.canonicalCategory]),
    ...plan.aliases.map((row) => [row.canonical_attraction_id, row.park_id, row.canonical_name, row.category])
  ], (row) => row[0]);
  await insertRows(client, "catalog.attractions", ["canonical_attraction_id", "park_id", "canonical_name", "category"], attractions);
  await insertRows(client, "catalog.attraction_aliases", ["park_id", "alias_name", "canonical_attraction_id", "notes"],
    plan.aliases.map((row) => [row.park_id, row.alias_name, row.canonical_attraction_id, row.notes || ""]));

  await insertRows(client, "ingestion.raw_archives", ["raw_archive_id", "sha256", "object_uri", "byte_size", "source_name", "schema_version"],
    plan.archives.map((row) => [row.rawArchiveId, row.sha256, objectUris.get(row.rawArchiveId), row.byteSize, row.sourceName, rawSchemaVersion]));
  await insertRows(client, "ingestion.raw_wait_observations", [
    "raw_observation_id", "raw_archive_id", "source_row_number", "snapshot_utc", "snapshot_park_datetime", "snapshot_park_date", "snapshot_timezone",
    "park_id", "park_name", "land", "ride_id", "ride_name", "is_open", "wait_time_minutes", "source_last_updated_utc",
    "source_last_updated_park_datetime", "source_url"
  ], plan.rawRecords.map((row) => [
    row.rawObservationId, row.rawArchiveId, row.sourceRowNumber, row.snapshotUtc, row.snapshotParkDatetime, row.snapshotParkDate, row.snapshotTimezone,
    row.parkId, row.parkName, row.land, row.rideId, row.rideName, row.isOpen, row.waitTimeMinutes, row.sourceLastUpdatedUtc,
    row.sourceLastUpdatedParkDatetime, row.sourceUrl
  ]));
  await insertRows(client, "observations.normalized_wait_observations", [
    "normalized_observation_id", "raw_observation_id", "canonical_attraction_id", "canonical_match_source", "access_mode", "is_open",
    "observed_wait_time_minutes", "source_age_minutes", "quality_flags", "training_eligibility", "transformation_version", "generated_at"
  ], plan.normalizedRecords.map((row) => [
    row.normalizedObservationId, row.rawObservationId, row.canonicalAttractionId, row.canonicalMatchSource, row.accessMode, row.isOpen,
    row.observedWaitTimeMinutes, row.sourceAgeMinutes, row.qualityFlags, row.trainingEligibility, row.transformationVersion, row.generatedAt
  ]));
}

async function insertRows(client, table, columns, rows) {
  const batchSize = 200;
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const values = batch.flat();
    const placeholders = batch.map((_, rowIndex) =>
      `(${columns.map((__, columnIndex) => `$${rowIndex * columns.length + columnIndex + 1}`).join(",")})`
    ).join(",");
    await client.query(`INSERT INTO ${table} (${columns.join(",")}) VALUES ${placeholders} ON CONFLICT DO NOTHING`, values);
  }
}

async function verifyDatabase(pool, plan) {
  const archiveIds = plan.archives.map((archive) => archive.rawArchiveId);
  const rawResult = await pool.query(
    "SELECT count(*)::integer AS count FROM ingestion.raw_wait_observations WHERE raw_archive_id::text = ANY($1::text[])",
    [archiveIds]
  );
  const normalizedResult = await pool.query(
    `SELECT count(*)::integer AS count
       FROM observations.normalized_wait_observations AS normalized
       JOIN ingestion.raw_wait_observations AS raw USING (raw_observation_id)
      WHERE raw.raw_archive_id::text = ANY($1::text[])
        AND normalized.transformation_version = $2`,
    [archiveIds, plan.normalizedRecords[0]?.transformationVersion || "bootstrap-analyzer.v0.5"]
  );
  const actual = { rawObservationCount: rawResult.rows[0].count, normalizedObservationCount: normalizedResult.rows[0].count };
  if (actual.rawObservationCount !== plan.report.rawObservationCount || actual.normalizedObservationCount !== plan.report.normalizedObservationCount) {
    throw new Error(`Database comparison failed: expected ${JSON.stringify(plan.report)}, got ${JSON.stringify(actual)}`);
  }
  return actual;
}

function uniqueBy(rows, key) {
  return [...new Map(rows.map((row) => [key(row), row])).values()];
}
