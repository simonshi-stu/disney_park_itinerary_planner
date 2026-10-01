import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPostgresArchiveLineReferenceRepository, calculateRawObservationId } from "../../infra/archive-line-reference-postgres.mjs";
import { CatalogEntryConflictError, createPostgresCatalogRepository } from "../../infra/catalog-postgres.mjs";
import { buildBackfillPlan, transformationVersion, replayTransformationVersion } from "../../infra/backfill/wait-time-records.mjs";
import {
  calculateNormalizedObservationId,
  createPostgresNormalizedObservationRepository,
  NormalizedObservationConflictError,
  withPostgresStorageTransaction
} from "../../infra/normalized-observations-postgres.mjs";
import { buildDatabaseParitySnapshot, buildFileParitySnapshot, buildReplayParityReport, queryDatabaseSnapshot } from "../../scripts/report-replay-parity.mjs";
import { createPostgresSourceHealthRepository } from "../../infra/source-health-postgres.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("versioned contracts preserve closed, access-mode, lineage, and timezone rules", async () => {
  const raw = JSON.parse(await readFile(path.join(root, "packages/contracts/schemas/v1/raw-wait-observation.schema.json"), "utf8"));
  const normalized = JSON.parse(await readFile(path.join(root, "packages/contracts/schemas/v1/normalized-wait-observation.schema.json"), "utf8"));
  assert.equal(raw.properties.snapshot_timezone.const, "America/Los_Angeles");
  assert.deepEqual(normalized.properties.access_mode.enum, ["standby", "single_rider", "virtual_queue", "other"]);
  assert.ok(normalized.required.includes("raw_observation_id"));
  assert.ok(normalized.required.includes("transformation_version"));
  assert.equal(normalized.allOf[0].then.properties.observed_wait_time_minutes.type, "null");
});

test("normalized-wait-observation.v2 is standalone, UTC, park-aware, and preserves wait semantics", async () => {
  const v1 = JSON.parse(await readFile(path.join(root, "packages/contracts/schemas/v1/normalized-wait-observation.schema.json"), "utf8"));
  const v2 = JSON.parse(await readFile(path.join(root, "packages/contracts/schemas/v2/normalized-wait-observation.schema.json"), "utf8"));
  assert.equal(v1.properties.contract_version.const, "normalized-wait-observation.v1", "v1 remains a separate compatibility contract");
  assert.equal(v2.properties.contract_version.const, "normalized-wait-observation.v2");
  for (const field of ["operator_id", "resort_id", "park_id", "park_timezone", "observed_at_utc", "raw_observation_id", "quality_flags", "transformation_version"]) {
    assert.ok(v2.required.includes(field), `${field} is required without a raw observation row`);
  }
  assert.equal(v2.properties.observed_at_utc.pattern, "Z$");
  assert.equal(v2.properties.generated_at.pattern, "Z$");
  assert.equal(v2.properties.raw_payload, undefined);

  assert.doesNotThrow(() => assertContractConformance(normalizedV2Fixture({ observed_wait_time_minutes: 0 }), v2));
  assert.doesNotThrow(() => assertContractConformance(normalizedV2Fixture({ observed_wait_time_minutes: null, quality_flags: ["missing_wait"] }), v2));
  assert.doesNotThrow(() => assertContractConformance(normalizedV2Fixture({ is_open: false, observed_wait_time_minutes: null, quality_flags: ["closed"] }), v2));
  assert.throws(() => assertContractConformance(normalizedV2Fixture({ is_open: false, observed_wait_time_minutes: 0 }), v2));
  assert.throws(() => assertContractConformance(normalizedV2Fixture({ observed_at_utc: "2026-09-24T10:15:00-07:00" }), v2));
});

test("raw-archive-line-reference.v1 provides immutable R2 lookup metadata without raw payload fields", async () => {
  const schema = JSON.parse(await readFile(path.join(root, "packages/contracts/schemas/v1/raw-archive-line-reference.schema.json"), "utf8"));
  const reference = {
    contract_version: "raw-archive-line-reference.v1",
    raw_observation_id: "a".repeat(64),
    raw_archive_id: "b".repeat(64),
    r2_uri: "s3://fixture-bucket/archives/2026-09-24/sample.csv",
    archive_sha256: "c".repeat(64),
    archive_byte_size: 384,
    source_line_number: 2,
    source_name: "wait_times_fixture.csv",
    archive_schema_version: "raw-wait-observation.v1"
  };

  assert.deepEqual(schema.required, [
    "contract_version", "raw_observation_id", "raw_archive_id", "r2_uri", "archive_sha256",
    "archive_byte_size", "source_line_number", "source_name", "archive_schema_version"
  ]);
  assert.doesNotThrow(() => assertContractConformance(reference, schema));
  assert.equal(schema.properties.raw_payload, undefined);
  assert.equal(schema.properties.raw_observation, undefined);
  assert.throws(() => assertContractConformance({ ...reference, source_line_number: 0 }, schema));
  assert.throws(() => assertContractConformance({ ...reference, r2_uri: "https://example.invalid/archive.csv" }, schema));
  assert.throws(() => assertContractConformance({ ...reference, archive_sha256: "not-a-sha256" }, schema));
  assert.throws(() => assertContractConformance({ ...reference, raw_payload: "must stay in R2" }, schema));
});

test("normalized v2 and archive-line v1 share independently computed header-excluded lineage", async () => {
  const normalizedSchema = JSON.parse(await readFile(path.join(root, "packages/contracts/schemas/v2/normalized-wait-observation.schema.json"), "utf8"));
  const referenceSchema = JSON.parse(await readFile(path.join(root, "packages/contracts/schemas/v1/raw-archive-line-reference.schema.json"), "utf8"));
  const archiveBytes = Buffer.from("snapshot_utc,ride_id\n2026-09-24T17:00:00.000Z,ride-1\n2026-09-24T17:05:00.000Z,ride-2\n", "utf8");
  const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
  const oneBasedDataRowOrdinal = 2; // Data rows start at 1; the CSV header is excluded.
  const expectedRawObservationId = createHash("sha256")
    .update(Buffer.from(`${archiveSha256}:${oneBasedDataRowOrdinal}`, "utf8"))
    .digest("hex");
  const normalized = normalizedV2Fixture({ raw_observation_id: expectedRawObservationId });
  const reference = {
    contract_version: "raw-archive-line-reference.v1",
    raw_observation_id: expectedRawObservationId,
    raw_archive_id: archiveSha256,
    r2_uri: "s3://fixture-bucket/archives/2026-09-24/sample.csv",
    archive_sha256: archiveSha256,
    archive_byte_size: archiveBytes.byteLength,
    source_line_number: oneBasedDataRowOrdinal,
    source_name: "sample.csv",
    archive_schema_version: "raw-wait-observation.v1"
  };

  assert.doesNotThrow(() => assertContractConformance(normalized, normalizedSchema));
  assert.doesNotThrow(() => assertContractConformance(reference, referenceSchema));

  const assertLineageMatches = (normalizedRecord, lineReference) => {
    const independentlyComputedId = createHash("sha256")
      .update(Buffer.from(`${lineReference.archive_sha256}:${lineReference.source_line_number}`, "utf8"))
      .digest("hex");
    assert.equal(normalizedRecord.raw_observation_id, independentlyComputedId);
    assert.equal(lineReference.raw_observation_id, independentlyComputedId);
  };

  assertLineageMatches(normalized, reference);
  assert.equal(normalized.raw_observation_id, reference.raw_observation_id);
  const changedId = `${reference.raw_observation_id[0] === "0" ? "1" : "0"}${reference.raw_observation_id.slice(1)}`;
  assert.throws(() => assertLineageMatches(normalized, { ...reference, raw_observation_id: changedId }));
  assert.throws(() => assertLineageMatches(normalized, { ...reference, archive_sha256: "e".repeat(64) }));
  assert.throws(() => assertLineageMatches(normalized, { ...reference, source_line_number: oneBasedDataRowOrdinal + 1 }));
});

test("0004 is additive and normalized-only with bounded indexes", async () => {
  const sql = await readFile(path.join(root, "infra/migrations/0004_r2_lineage_normalized_observations.sql"), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ingestion\.raw_archive_line_references/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS observations\.normalized_wait_observations_v2/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS catalog\.catalog_entry_snapshots/);
  assert.match(sql, /REFERENCES ingestion\.raw_archive_line_references \(raw_observation_id\)/);
  assert.match(sql, /observed_at_utc timestamptz NOT NULL/);
  assert.match(sql, /park_timezone text NOT NULL/);
  assert.match(sql, /CHECK \(is_open OR observed_wait_time_minutes IS NULL\)/);
  assert.doesNotMatch(sql, /REFERENCES ingestion\.raw_wait_observations/);
  assert.doesNotMatch(sql, /INSERT INTO ingestion\.raw_wait_observations/);
  assert.doesNotMatch(sql, /ALTER TABLE observations\.normalized_wait_observations\b/);
  assert.doesNotMatch(sql, /UNIQUE \(raw_observation_id, transformation_version\)/,
    "the validated stable normalized key and its primary key provide uniqueness without a duplicate B-tree");
  assert.doesNotMatch(sql, /UNIQUE \(archive_sha256, source_line_number\)/,
    "the validated stable raw-line key and its primary key provide uniqueness without a duplicate B-tree");
  assert.equal((sql.match(/CREATE INDEX IF NOT EXISTS/g) || []).length, 1,
    "retain only the park/event-time lookup index in addition to primary/natural-key indexes");
});

test("new 04d3 repositories reject bare clients while the legacy source-health adapter remains compatible", () => {
  const bareClient = { async query() { return { rows: [] }; } };
  assert.throws(() => createPostgresArchiveLineReferenceRepository(bareClient), /require the client provided inside/);
  assert.throws(() => createPostgresCatalogRepository(bareClient), /require the client provided inside/);
  assert.throws(() => createPostgresNormalizedObservationRepository(bareClient), /require the client provided inside/);
  assert.doesNotThrow(() => createPostgresSourceHealthRepository(bareClient));
});

test("repository methods reject escaped transactions even after a pooled client is reused", async () => {
  const fake = createTransactionalFakePool();
  const reference = archiveLineReferenceFixture();
  const entry = catalogEntryStorageFixture("dca-escaped-repository-ride");
  let escaped;
  await withPostgresStorageTransaction(fake.pool, async (client) => {
    escaped = {
      archive: createPostgresArchiveLineReferenceRepository(client),
      catalog: createPostgresCatalogRepository(client),
      normalized: createPostgresNormalizedObservationRepository(client)
    };
    await escaped.archive.putArchiveLineReference(reference);
  });
  const queryCountAfterRelease = fake.queries.length;

  await assert.rejects(escaped.archive.putArchiveLineReference(reference), /require the client provided inside/);
  await assert.rejects(escaped.archive.getArchiveLineReference(reference.raw_observation_id), /require the client provided inside/);
  await assert.rejects(escaped.catalog.putCatalogEntry(entry), /require the client provided inside/);
  await assert.rejects(escaped.catalog.listCatalogEntries({
    parkId: entry.park_id,
    catalogVersion: entry.lifecycle.catalog_version,
    asOfDate: entry.lifecycle.valid_from
  }), /require the client provided inside/);
  await assert.rejects(escaped.normalized.putNormalizedObservation(normalizedV2StorageFixture(reference)),
    /require the client provided inside/);
  assert.equal(fake.queries.length, queryCountAfterRelease, "escaped repositories issue no autocommit query");

  await withPostgresStorageTransaction(fake.pool, async (client) => {
    const queryCountAfterBegin = fake.queries.length;
    await assert.rejects(escaped.archive.getArchiveLineReference(reference.raw_observation_id),
      /require the client provided inside/);
    await assert.rejects(escaped.archive.putArchiveLineReference(reference),
      /require the client provided inside/);
    await assert.rejects(escaped.catalog.putCatalogEntry(entry),
      /require the client provided inside/);
    await assert.rejects(escaped.catalog.listCatalogEntries({
      parkId: entry.park_id,
      catalogVersion: entry.lifecycle.catalog_version,
      asOfDate: entry.lifecycle.valid_from
    }), /require the client provided inside/);
    await assert.rejects(escaped.normalized.putNormalizedObservation(normalizedV2StorageFixture(reference)),
      /require the client provided inside/);
    assert.equal(fake.queries.length, queryCountAfterBegin,
      "all old repositories remain invalid while the same client has a newer transaction token");

    const currentRepository = createPostgresArchiveLineReferenceRepository(client);
    assert.deepEqual(await currentRepository.getArchiveLineReference(reference.raw_observation_id), reference);
  });
});

test("transaction wrapper destroys clients when COMMIT or ROLLBACK state is uncertain", async () => {
  const commitError = new Error("connection lost during COMMIT");
  const commitFailure = createTransactionBoundaryPool({ commitError });
  await assert.rejects(
    withPostgresStorageTransaction(commitFailure.pool, async () => "result"),
    (error) => error === commitError
  );
  assert.deepEqual(commitFailure.queries, ["BEGIN", "COMMIT"]);
  assert.equal(commitFailure.releaseErrors[0], commitError, "pg release(error) destroys the uncertain client");

  const primaryError = new Error("write failed");
  const rollbackError = new Error("connection lost during ROLLBACK");
  const rollbackFailure = createTransactionBoundaryPool({ rollbackError });
  await assert.rejects(
    withPostgresStorageTransaction(rollbackFailure.pool, async () => { throw primaryError; }),
    (error) => error === primaryError && error.rollbackError === rollbackError
  );
  assert.deepEqual(rollbackFailure.queries, ["BEGIN", "ROLLBACK"]);
  assert.equal(rollbackFailure.releaseErrors[0], rollbackError, "rollback failure also destroys the client");

  const safelyRolledBack = createTransactionBoundaryPool();
  await assert.rejects(
    withPostgresStorageTransaction(safelyRolledBack.pool, async () => { throw primaryError; }),
    (error) => error === primaryError
  );
  assert.deepEqual(safelyRolledBack.queries, ["BEGIN", "ROLLBACK"]);
  assert.equal(safelyRolledBack.releaseErrors[0], undefined, "a confirmed rollback allows safe pool reuse");
});

test("PostgreSQL archive-line adapter validates stable R2 lineage and stores reference metadata only", async () => {
  const reference = archiveLineReferenceFixture();
  const fake = createTransactionalFakePool();
  const { pool, queries } = fake;
  const stored = await withPostgresStorageTransaction(pool, async (client) => {
    const repository = createPostgresArchiveLineReferenceRepository(client);
    const firstWrite = await repository.putArchiveLineReference(reference);
    assert.deepEqual(await repository.putArchiveLineReference(reference), firstWrite);
    return firstWrite;
  });

  assert.deepEqual(stored, reference);
  assert.equal(fake.state.references.size, 1);
  assert.equal(fake.state.references.get(reference.raw_observation_id).r2_uri, reference.r2_uri);
  const insert = queries.find(({ sql }) => sql.includes("INSERT INTO ingestion.raw_archive_line_references"));
  assert.ok(insert);
  assert.doesNotMatch(insert.sql, /raw_payload|ride_name|wait_time_minutes/i);
  assert.equal(calculateRawObservationId(reference.archive_sha256, reference.source_line_number), reference.raw_observation_id);

  const invalid = { ...reference, source_line_number: reference.source_line_number + 1 };
  await assert.rejects(
    withPostgresStorageTransaction(pool, (client) =>
      createPostgresArchiveLineReferenceRepository(client).putArchiveLineReference(invalid)),
    /raw_observation_id does not match/
  );
  await assert.rejects(
    withPostgresStorageTransaction(pool, (client) =>
      createPostgresArchiveLineReferenceRepository(client).putArchiveLineReference({ ...reference, raw_payload: "forbidden" })),
    /exactly its declared fields/
  );
});

test("normalized v2 retry preserves first generated_at and rejects any semantic conflict", async () => {
  const reference = archiveLineReferenceFixture();
  const first = normalizedV2StorageFixture(reference);
  const retry = { ...first, generated_at: "2026-09-25T18:00:00.000Z" };
  const fake = createTransactionalFakePool();
  const { pool, queries } = fake;

  const initial = await withPostgresStorageTransaction(pool, async (client) => {
    await createPostgresArchiveLineReferenceRepository(client).putArchiveLineReference(reference);
    return createPostgresNormalizedObservationRepository(client).putNormalizedObservation(first);
  });
  const replay = await withPostgresStorageTransaction(pool, (client) =>
    createPostgresNormalizedObservationRepository(client).putNormalizedObservation(retry));

  assert.equal(initial.generated_at, first.generated_at);
  assert.equal(replay.generated_at, first.generated_at);
  assert.equal(fake.state.normalized.get(first.normalized_observation_id).generated_at, first.generated_at);
  assert.equal(queries.filter(({ sql }) => sql.includes("INSERT INTO observations.normalized_wait_observations_v2")).length, 1);
  const compareQuery = queries.find(({ sql }) => sql.includes("same_semantic_payload"));
  assert.ok(compareQuery.sql.includes("access_mode IS NOT DISTINCT FROM"));
  assert.ok(compareQuery.sql.includes("observed_at_utc IS NOT DISTINCT FROM"));
  assert.ok(compareQuery.sql.includes("quality_flags IS NOT DISTINCT FROM"));
  assert.equal(compareQuery.params.length, 19, "every normalized-v2 field except generated_at participates in equality");
  assert.equal(compareQuery.params.at(-1), first.transformation_version);
  assert.ok(!compareQuery.sql.slice(0, compareQuery.sql.indexOf("FROM observations.normalized_wait_observations_v2")).includes("generated_at IS NOT DISTINCT FROM"));

  const modeCorrection = { ...retry, access_mode: "single_rider" };
  await assert.rejects(
    withPostgresStorageTransaction(pool, (client) =>
      createPostgresNormalizedObservationRepository(client).putNormalizedObservation(modeCorrection)),
    (error) => error instanceof NormalizedObservationConflictError && error.code === "NORMALIZED_OBSERVATION_CONFLICT"
  );
  assert.equal(fake.state.normalized.get(first.normalized_observation_id).access_mode, "standby");
  assert.equal(fake.state.normalized.get(first.normalized_observation_id).generated_at, first.generated_at);

  const closedWithWait = { ...first, is_open: false, observed_wait_time_minutes: 0 };
  await assert.rejects(
    withPostgresStorageTransaction(pool, (client) =>
      createPostgresNormalizedObservationRepository(client).putNormalizedObservation(closedWithWait)),
    /closed normalized observations must have a null wait/
  );
  assert.equal(fake.state.references.has(reference.raw_observation_id), true);
});

test("normalized writes require their immutable archive-line reference first", async () => {
  const reference = archiveLineReferenceFixture("d");
  const record = normalizedV2StorageFixture(reference);
  const fake = createTransactionalFakePool();
  await assert.rejects(
    withPostgresStorageTransaction(fake.pool, (client) =>
      createPostgresNormalizedObservationRepository(client).putNormalizedObservation(record)),
    (error) => error.code === "23503"
  );
  assert.equal(fake.state.normalized.size, 0);
});

test("catalog, archive-line, normalized, and source-health ports share one caller transaction with atomic rollback", async () => {
  const reference = archiveLineReferenceFixture("e");
  const catalogEntry = catalogEntryStorageFixture("dca-transactional-ride");
  const normalized = normalizedV2StorageFixture(reference, {
    canonical_attraction_id: catalogEntry.canonical_attraction_id,
    canonical_attraction_name: catalogEntry.canonical_attraction_name
  });
  const health = sourceHealthStorageFixture("transaction-atomicity");
  const successful = createTransactionalFakePool();
  const result = await withPostgresStorageTransaction(successful.pool, async (client) => {
    const archiveRepository = createPostgresArchiveLineReferenceRepository(client);
    const archive = await archiveRepository.putArchiveLineReference(reference);
    assert.deepEqual(await archiveRepository.putArchiveLineReference(reference), archive);
    const catalogRepository = createPostgresCatalogRepository(client);
    const catalog = await catalogRepository.putCatalogEntry(catalogEntry);
    const catalogReplay = await catalogRepository.putCatalogEntry(catalogEntry);
    const observation = await createPostgresNormalizedObservationRepository(client).putNormalizedObservation(normalized);
    await createPostgresSourceHealthRepository(client).upsertSourceHealth(health);
    return { archive, catalog, catalogReplay, observation };
  });

  assert.equal(successful.state.references.size, 1);
  assert.equal(successful.state.catalogEntries.size, 1);
  assert.equal(successful.state.normalized.size, 1);
  assert.equal(successful.state.sourceHealth.size, 1);
  assert.equal(successful.queries.filter(({ sql }) => sql === "BEGIN").length, 1);
  assert.equal(successful.queries.filter(({ sql }) => sql === "COMMIT").length, 1);
  assert.equal(successful.queries.filter(({ sql }) => sql === "ROLLBACK").length, 0);
  assert.equal(result.catalog.inserted, true);
  assert.equal(result.catalogReplay.inserted, false);
  assert.equal(result.observation.generated_at, normalized.generated_at);

  const semanticCatalogConflict = {
    ...catalogEntry,
    aliases: ["Changed Alias Within Same Catalog Version"]
  };
  await assert.rejects(withPostgresStorageTransaction(successful.pool, (client) =>
    createPostgresCatalogRepository(client).putCatalogEntry(semanticCatalogConflict)),
  (error) => error instanceof CatalogEntryConflictError && error.code === "CATALOG_ENTRY_CONFLICT");
  assert.equal(successful.state.catalogEntries.size, 1, "catalog conflict does not mutate the stored snapshot");

  const failingReference = archiveLineReferenceFixture("f");
  const failingCatalogEntry = catalogEntryStorageFixture("dca-rollback-ride");
  const conflictingNormalized = normalizedV2StorageFixture(failingReference, {
    canonical_attraction_id: failingCatalogEntry.canonical_attraction_id,
    canonical_attraction_name: failingCatalogEntry.canonical_attraction_name
  });
  const persistedConflict = { ...conflictingNormalized, access_mode: "single_rider" };
  const failed = createTransactionalFakePool({ seedNormalized: [persistedConflict] });
  await assert.rejects(withPostgresStorageTransaction(failed.pool, async (client) => {
    await createPostgresArchiveLineReferenceRepository(client).putArchiveLineReference(failingReference);
    await createPostgresCatalogRepository(client).putCatalogEntry(failingCatalogEntry);
    await createPostgresNormalizedObservationRepository(client).putNormalizedObservation(conflictingNormalized);
    await createPostgresSourceHealthRepository(client).upsertSourceHealth(health);
  }), (error) => error.code === "NORMALIZED_OBSERVATION_CONFLICT");

  assert.equal(failed.state.references.size, 0, "first write is rolled back");
  assert.equal(failed.state.catalogEntries.size, 0, "second write is rolled back");
  assert.equal(failed.state.normalized.get(conflictingNormalized.normalized_observation_id).access_mode, "single_rider");
  assert.equal(failed.state.sourceHealth.size, 0, "later source-health write is not reached");
  assert.equal(failed.queries.filter(({ sql }) => sql === "BEGIN").length, 1);
  assert.equal(failed.queries.filter(({ sql }) => sql === "COMMIT").length, 0);
  assert.equal(failed.queries.filter(({ sql }) => sql === "ROLLBACK").length, 1);
});

test("hosted backfill v1 contract keeps Git archive evidence complete and documents optional bounded diagnostics", async () => {
  const schema = JSON.parse(await readFile(path.join(root, "packages/contracts/schemas/v1/hosted-backfill-report.schema.json"), "utf8"));
  assert.equal(schema.properties.archives.maxItems, undefined);
  assert.ok(!schema.required.includes("diagnostic_samples"), "older v1 reports remain readable");
  assert.deepEqual(schema.properties.diagnostic_samples.required, ["sample_limit", "git_archives", "neon_only", "r2_only", "hosted_only", "replay_parity"]);
  assert.ok(schema.$defs.parity_check.properties.mismatch_count);
  assert.ok(schema.$defs.parity_check.properties.difference_count);
});

test("PostgreSQL migration makes raw data immutable and keeps closed waits out of analysis", async () => {
  const sql = await readFile(path.join(root, "infra/migrations/0001_observation_storage.sql"), "utf8");
  assert.match(sql, /raw_wait_observations_are_immutable/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON ingestion\.raw_wait_observations/);
  assert.match(sql, /CHECK \(is_open OR observed_wait_time_minutes IS NULL\)/);
  assert.match(sql, /normalized\.access_mode = 'standby'/);
  assert.match(sql, /normalized\.is_open/);
});

test("backfill keeps Single Rider but excludes it from standby analysis and links every normalized row", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "wait-storage-"));
  try {
    await mkdir(path.join(fixtureRoot, "data/wait_times"), { recursive: true });
    await mkdir(path.join(fixtureRoot, "data/processed/wait_times"), { recursive: true });
    await mkdir(path.join(fixtureRoot, "data/catalog"), { recursive: true });
    await writeFile(path.join(fixtureRoot, "data/wait_times/wait_times_2026-07-01.csv"), rawFixture, "utf8");
    await writeFile(path.join(fixtureRoot, "data/processed/wait_times/wait_times_cleaned_2026-07-01.csv"), cleanedFixture, "utf8");
    await writeFile(path.join(fixtureRoot, "data/catalog/attraction-aliases.csv"), aliasFixture, "utf8");
    const plan = await buildBackfillPlan(fixtureRoot, { generatedAt: "2026-07-02T00:00:00.000Z" });
    assert.equal(plan.report.rawObservationCount, 4);
    assert.equal(plan.report.normalizedObservationCount, 3);
    assert.equal(plan.report.singleRiderCount, 1);
    assert.equal(plan.report.standbyAnalysisCount, 1);
    assert.equal(plan.report.closedWithObservedWait, 0);
    assert.equal(plan.normalizedRecords[0].transformationVersion, transformationVersion);
    assert.ok(plan.normalizedRecords.every((row) => plan.rawRecords.some((raw) => raw.rawObservationId === row.rawObservationId)));
    assert.equal(plan.normalizedRecords.find((row) => !row.isOpen).observedWaitTimeMinutes, null);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("0002 catalog lifecycle migration matches the Phase 1 contract", async () => {
  const sql0001 = await readFile(path.join(root, "infra/migrations/0001_observation_storage.sql"), "utf8");
  const sql0002 = await readFile(path.join(root, "infra/migrations/0002_catalog_lifecycle_and_indexes.sql"), "utf8");
  const schema = JSON.parse(await readFile(path.join(root, "packages/contracts/schemas/v1/catalog-attraction-lifecycle.schema.json"), "utf8"));

  // Lifecycle vocabularies must match the JSON Schema enums.
  const waitCapabilityEnum = schema.properties.wait_capability.enum;
  const accessModesEnum = schema.properties.supported_access_modes.items.enum;
  const operationalStateEnum = schema.properties.operational_state.enum;
  const trainingDispositionEnum = schema.properties.training_disposition.enum;
  const planningDispositionEnum = schema.properties.planning_disposition.enum;

  // Assert SQL contains every enum literal from the schema.
  for (const value of waitCapabilityEnum) {
    assert.match(sql0002, new RegExp(`'${value}'`));
  }
  for (const value of accessModesEnum) {
    assert.match(sql0002, new RegExp(`'${value}'`));
  }
  for (const value of operationalStateEnum) {
    assert.match(sql0002, new RegExp(`'${value}'`));
  }
  for (const value of trainingDispositionEnum) {
    assert.match(sql0002, new RegExp(`'${value}'`));
  }
  for (const value of planningDispositionEnum) {
    assert.match(sql0002, new RegExp(`'${value}'`));
  }

  // Disposition rules: refurbishment/retired and unknown must match the schema's allOf constraints.
  assert.match(sql0002, /\(operational_state IN \('refurbishment', 'retired'\)\s*AND training_disposition = 'ineligible_lifecycle'\s*AND planning_disposition = 'ineligible_lifecycle'\)/);
  assert.match(sql0002, /\(operational_state = 'unknown'\s*AND training_disposition = 'review_required'\s*AND planning_disposition = 'review_required'\)/);

  // No SELECT or EXISTS directly inside CHECK expressions (focused regression for known invalid subquery form).
  assert.match(sql0002, /catalog\.text_array_has_unique_values\(supported_access_modes\)/);
  assert.doesNotMatch(sql0002, /supported_access_modes = ARRAY\(SELECT/i);
  assert.doesNotMatch(sql0002, /ARRAY\s*\(\s*SELECT DISTINCT unnest/i);
  assert.match(sql0002, /text_array_has_unique_values\(input_values text\[\]\)/);
  assert.doesNotMatch(sql0002, /text_array_has_unique_values\(values text\[\]\)/);

  // Deferred evidence enforcement: constraint trigger must be DEFERRABLE INITIALLY DEFERRED.
  assert.match(sql0002, /CREATE CONSTRAINT TRIGGER lifecycle_requires_evidence\s*AFTER INSERT OR UPDATE ON catalog\.lifecycle_records\s*DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql0002, /catalog\.validate_lifecycle_evidence\(\)/);

  // Evidence enforcement logic: must check evidence_count = 0 for all lifecycle rows.
  assert.match(sql0002, /IF evidence_count = 0 THEN/);
  assert.match(sql0002, /RAISE EXCEPTION 'lifecycle record % requires at least one evidence row'/);

  // Official evidence enforcement: must check official_count = 0 for non-unknown states.
  assert.match(sql0002, /IF NEW\.operational_state IN \('operating', 'refurbishment', 'seasonal', 'retired'\) THEN/);
  assert.match(sql0002, /IF official_count = 0 THEN/);
  assert.match(sql0002, /RAISE EXCEPTION 'lifecycle record % requires at least one official Disney evidence source'/);
  assert.match(sql0002, /source_type IN \('official_disney_page', 'official_disney_app'\)/);

  // Append-only lifecycle and evidence triggers.
  assert.match(sql0002, /CREATE TRIGGER lifecycle_records_are_immutable\s*BEFORE UPDATE OR DELETE ON catalog\.lifecycle_records/);
  assert.match(sql0002, /CREATE TRIGGER lifecycle_evidence_are_immutable\s*BEFORE UPDATE OR DELETE ON catalog\.lifecycle_evidence/);

  // Valid dates: valid_to must be null or greater than valid_from.
  assert.match(sql0002, /CHECK \(valid_to IS NULL OR valid_to > valid_from\)/);

  // Empty supported_access_modes array must remain allowed (no cardinality > 0 constraint).
  assert.doesNotMatch(sql0002, /cardinality\s*\(supported_access_modes\)\s*>\s*0/);

  // Indexes must use real 0001 columns; no normalized index on park_id or snapshot_park_date.
  assert.match(sql0001, /park_id text NOT NULL REFERENCES catalog\.parks \(park_id\)/);
  assert.match(sql0001, /snapshot_park_date date NOT NULL/);
  assert.match(sql0001, /snapshot_utc timestamptz NOT NULL/);
  assert.match(sql0002, /CREATE INDEX IF NOT EXISTS lifecycle_records_attraction_valid_idx\s*ON catalog\.lifecycle_records \(canonical_attraction_id, valid_from, valid_to\)/);
  assert.match(sql0002, /CREATE INDEX IF NOT EXISTS lifecycle_records_state_disposition_idx\s*ON catalog\.lifecycle_records \(operational_state, training_disposition, planning_disposition\)/);
  assert.match(sql0002, /CREATE INDEX IF NOT EXISTS lifecycle_evidence_record_idx\s*ON catalog\.lifecycle_evidence \(lifecycle_record_id\)/);
  assert.match(sql0002, /CREATE INDEX IF NOT EXISTS raw_wait_park_date_time_idx\s*ON ingestion\.raw_wait_observations \(park_id, snapshot_park_date, snapshot_utc\)/);
  assert.doesNotMatch(sql0002, /ON observations\.normalized_wait_observations \(park_id/);
  assert.doesNotMatch(sql0002, /ON observations\.normalized_wait_observations \(snapshot_park_date/);
});

test("backfill uses the shared migration runner and never hardcodes 0001", async () => {
  const backfillSource = await readFile(path.join(root, "scripts/backfill-wait-times-to-postgres.mjs"), "utf8");
  assert.match(backfillSource, /runMigrations/);
  assert.doesNotMatch(backfillSource, /0001_observation_storage\.sql/);
});

test("target-normalizer replay covers raw-only dates with target semantics and stays idempotent", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "replay-storage-"));
  try {
    await mkdir(path.join(fixtureRoot, "data/wait_times"), { recursive: true });
    await mkdir(path.join(fixtureRoot, "data/processed/wait_times"), { recursive: true });
    await mkdir(path.join(fixtureRoot, "data/catalog"), { recursive: true });
    await writeFile(path.join(fixtureRoot, "data/wait_times/wait_times_2026-07-09.csv"), replayRawFixture, "utf8");
    await writeFile(path.join(fixtureRoot, "data/catalog/attraction-aliases.csv"), aliasFixture, "utf8");

    const plan = await buildBackfillPlan(fixtureRoot, { generatedAt: "2026-07-10T00:00:00.000Z" });
    assert.deepEqual(plan.report.missingNormalizedDates, ["2026-07-09"]);
    assert.deepEqual(plan.report.replayedNormalizedDates, ["2026-07-09"]);
    assert.equal(plan.report.replayedNormalizedCount, plan.normalizedRecords.length);
    assert.ok(plan.normalizedRecords.every((row) => row.transformationVersion === replayTransformationVersion));
    assert.ok(plan.normalizedRecords.every((row) => plan.rawRecords.some((raw) => raw.rawObservationId === row.rawObservationId)));

    const closed = plan.normalizedRecords.find((row) => !row.isOpen);
    assert.equal(closed.observedWaitTimeMinutes, null);
    const openMissing = plan.normalizedRecords.find((row) => row.qualityFlags.includes("missing_wait"));
    assert.equal(openMissing.observedWaitTimeMinutes, null);
    const openZero = plan.normalizedRecords.find((row) => row.qualityFlags.includes("open_zero"));
    assert.equal(openZero.observedWaitTimeMinutes, 0);
    const singleRider = plan.normalizedRecords.find((row) => row.accessMode === "single_rider");
    assert.equal(singleRider.canonicalAttractionId, "dca-soarin");
    assert.equal(singleRider.canonicalMatchSource, "alias_base");

    const second = await buildBackfillPlan(fixtureRoot, { generatedAt: "2026-07-10T00:00:00.000Z" });
    assert.deepEqual(
      second.normalizedRecords.map((row) => row.normalizedObservationId),
      plan.normalizedRecords.map((row) => row.normalizedObservationId)
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("replay parity is read-only, compares the injected database snapshot, and excludes semantic mismatches by date", async () => {
  const rawRows = [
    { rawObservationId: "r-1", rawArchiveId: "archive-1", sha256: "hash-1", snapshotUtc: "2026-07-09T17:00:00.000Z", snapshotParkDate: "2026-07-09", parkId: "dca", rideId: "ride-1", rideName: "Soarin' Across America", isOpen: true, waitTimeMinutes: 25 },
    { rawObservationId: "r-2", rawArchiveId: "archive-1", sha256: "hash-1", snapshotUtc: "2026-07-09T17:00:00.000Z", snapshotParkDate: "2026-07-09", parkId: "dca", rideId: "ride-2", rideName: "Space Mountain", isOpen: true, waitTimeMinutes: null },
    { rawObservationId: "r-3", rawArchiveId: "archive-1", sha256: "hash-1", snapshotUtc: "2026-07-09T17:00:00.000Z", snapshotParkDate: "2026-07-09", parkId: "dca", rideId: "ride-3", rideName: "Matterhorn", isOpen: true, waitTimeMinutes: 0 },
    { rawObservationId: "r-4", rawArchiveId: "archive-1", sha256: "hash-1", snapshotUtc: "2026-07-09T17:00:00.000Z", snapshotParkDate: "2026-07-09", parkId: "dca", rideId: "ride-4", rideName: "Closed Ride", isOpen: false, waitTimeMinutes: 0 }
  ];
  const normalizedRows = [
    { normalizedObservationId: "n-1", rawObservationId: "r-1", canonicalAttractionId: "dca-soarin", accessMode: "standby", isOpen: true, observedWaitTimeMinutes: 25, qualityFlags: [], trainingEligibility: "standby_wait_model", transformationVersion: "target-normalizer.v1", generatedAt: "2026-07-10T00:00:00.000Z", snapshotParkDate: "2026-07-09", parkId: "dca" },
    { normalizedObservationId: "n-2", rawObservationId: "r-2", canonicalAttractionId: "disneyland-space-mountain", accessMode: "standby", isOpen: true, observedWaitTimeMinutes: null, qualityFlags: ["missing_wait"], trainingEligibility: "exclude_missing_wait", transformationVersion: "target-normalizer.v1", generatedAt: "2026-07-10T00:00:00.000Z", snapshotParkDate: "2026-07-09", parkId: "dca" },
    { normalizedObservationId: "n-3", rawObservationId: "r-3", canonicalAttractionId: "dca-matterhorn", accessMode: "standby", isOpen: true, observedWaitTimeMinutes: 0, qualityFlags: ["open_zero"], trainingEligibility: "standby_wait_model", transformationVersion: "target-normalizer.v1", generatedAt: "2026-07-10T00:00:00.000Z", snapshotParkDate: "2026-07-09", parkId: "dca" },
    { normalizedObservationId: "n-4", rawObservationId: "r-4", canonicalAttractionId: "dca-closed", accessMode: "standby", isOpen: false, observedWaitTimeMinutes: null, qualityFlags: ["closed"], trainingEligibility: "status_model_only", transformationVersion: "target-normalizer.v1", generatedAt: "2026-07-10T00:00:00.000Z", snapshotParkDate: "2026-07-09", parkId: "dca" }
  ];
  const operatingWindows = [{ date: "2026-07-09", parkId: "dca", openingTime: "2026-07-09T16:00:00.000Z", closingTime: "2026-07-10T00:00:00.000Z" }];
  const file = buildFileParitySnapshot({ rawRecords: rawRows, normalizedRecords: normalizedRows, archives: [{ rawArchiveId: "archive-1", sha256: "hash-1" }] }, { operatingWindows });
  const dbRawRows = rawRows.map((row) => ({
    raw_observation_id: row.rawObservationId, raw_archive_id: row.rawArchiveId, sha256: row.sha256,
    snapshot_utc: row.snapshotUtc, snapshot_park_date: row.snapshotParkDate, park_id: row.parkId,
    ride_id: row.rideId, ride_name: row.rideName, is_open: row.isOpen, wait_time_minutes: row.waitTimeMinutes
  }));
  const dbNormalizedRows = normalizedRows.map((row) => ({
    normalized_observation_id: row.normalizedObservationId, raw_observation_id: row.rawObservationId,
    canonical_attraction_id: row.canonicalAttractionId, access_mode: row.accessMode, is_open: row.isOpen,
    observed_wait_time_minutes: row.observedWaitTimeMinutes, quality_flags: row.qualityFlags,
    training_eligibility: row.trainingEligibility, transformation_version: row.transformationVersion,
    generated_at: row.generatedAt, snapshot_park_date: row.snapshotParkDate, park_id: row.parkId
  }));
  const fakeClient = {
    query(sql) {
      return Promise.resolve({ rows: sql.includes("normalized.normalized_observation_id") ? dbNormalizedRows : dbRawRows });
    }
  };
  const database = await queryDatabaseSnapshot(fakeClient, { dates: ["2026-07-09"], operatingWindows });
  const matched = buildReplayParityReport(file, database, { runId: "parity-test", generatedAt: "2026-07-10T00:00:00.000Z" });
  assert.equal(matched.status, "passed");
  assert.deepEqual(matched.excluded_dates, []);
  assert.equal(matched.dates[0].file.archive_hashes[0], "hash-1");
  assert.equal(matched.dates[0].file.operating_window_coverage[0].inside_window_observation_count, 4);
  assert.equal(matched.dates[0].file.lineage.normalized_orphan_count, 0);
  assert.deepEqual(matched.dates[0].file.canonical_identity, { "dca-closed": 1, "dca-matterhorn": 1, "dca-soarin": 1, "disneyland-space-mountain": 1 });

  const semanticMismatchRows = dbNormalizedRows.map((row) => row.normalized_observation_id === "n-4"
    ? { ...row, observed_wait_time_minutes: 0 }
    : row);
  const mismatchedDatabase = buildDatabaseParitySnapshot({ rawRows: dbRawRows, normalizedRows: semanticMismatchRows }, { operatingWindows });
  const blocked = buildReplayParityReport(file, mismatchedDatabase, { runId: "parity-test-mismatch" });
  assert.equal(blocked.status, "blocked");
  assert.deepEqual(blocked.excluded_dates, ["2026-07-09"]);
  assert.ok(blocked.failures.some((failure) => failure.code === "closed_zero_semantics_mismatch" && failure.date === "2026-07-09"));
  assert.deepEqual(blocked.training_eligible_dates, []);

  const countHashLineageMismatch = buildReplayParityReport(
    file,
    buildDatabaseParitySnapshot({
      rawRows: dbRawRows.slice(0, -1),
      normalizedRows: dbNormalizedRows.slice(0, -1),
      archives: [{ rawArchiveId: "archive-1", sha256: "different-hash" }]
    }, { operatingWindows }),
    { runId: "parity-test-count-hash-lineage" }
  );
  assert.ok(countHashLineageMismatch.checks.counts.mismatches.some((mismatch) => mismatch.type === "raw_count"));
  assert.ok(countHashLineageMismatch.checks.hashes.mismatches.some((mismatch) => mismatch.type === "archive_hashes"));
  assert.ok(countHashLineageMismatch.checks.lineage.mismatches.some((mismatch) => mismatch.type === "missing_normalized_lineage"));
});

test("replay parity bounds difference samples while counting every mismatch and excluding every affected date", () => {
  const rawRecords = Array.from({ length: 64 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10);
    return {
      rawObservationId: `raw-${String(index).padStart(3, "0")}`,
      rawArchiveId: "archive-many-dates",
      snapshotParkDate: date,
      snapshotUtc: `${date}T17:00:00.000Z`,
      parkId: "dca",
      parkName: "Disney California Adventure",
      rideId: `ride-${index}`,
      rideName: `Ride ${index}`,
      isOpen: true,
      waitTimeMinutes: 15
    };
  });
  const normalizedRecords = rawRecords.map((raw, index) => ({
    normalizedObservationId: `normalized-${String(index).padStart(3, "0")}`,
    rawObservationId: raw.rawObservationId,
    canonicalAttractionId: `dca-attraction-${index}`,
    accessMode: "standby",
    isOpen: true,
    observedWaitTimeMinutes: 15,
    transformationVersion: "target-normalizer.v1"
  }));
  const archives = [{ rawArchiveId: "archive-many-dates", sha256: "archive-hash" }];
  const operatingWindows = rawRecords.map(({ snapshotParkDate: date }) => ({
    date,
    parkId: "dca",
    openingTime: `${date}T16:00:00.000Z`,
    closingTime: `${date}T23:00:00.000Z`
  }));
  const file = buildFileParitySnapshot({ rawRecords, normalizedRecords, archives }, { operatingWindows });
  const database = buildDatabaseParitySnapshot({ rawRows: rawRecords, normalizedRows: [], archives }, { operatingWindows });

  const report = buildReplayParityReport({
    plan: file,
    databaseSnapshot: database,
    operatingWindows,
    runId: "large-difference-fixture"
  });

  assert.equal(report.status, "blocked");
  assert.equal(report.failure_count, 192);
  assert.equal(report.checks.lineage.passed, false);
  assert.equal(report.checks.lineage.mismatch_count, 64);
  assert.equal(report.checks.lineage.difference_count, 64);
  assert.equal(report.checks.lineage.mismatches.length, 20);
  assert.equal(report.checks.lineage.omitted_mismatch_count, 44);
  assert.equal(report.checks.lineage.mismatches[0].expected_count, 1);
  assert.equal(report.checks.canonical_identity.difference_count, 64);
  assert.equal(report.checks.counts.mismatch_count, 64);
  assert.equal(report.dates.length, 64);
  assert.ok(report.dates.every((entry) => entry.status === "excluded" && entry.mismatch_count > 0));
  assert.equal(report.excluded_dates.length, 64);
  assert.deepEqual(report.training_eligible_dates, []);
  assert.ok(report.failures.some((failure) => failure.type === "additional_parity_mismatches_omitted"));
  assert.ok(JSON.stringify(report).length < 100_000, "bounded parity diagnostics should remain serializable and small");
});

test("missing database snapshot never marks unchecked parity checks as passed", () => {
  const date = "2026-07-09";
  const report = buildReplayParityReport({
    plan: buildFileParitySnapshot({
      archives: [{ rawArchiveId: "archive-a", sha256: "hash-a" }],
      rawRecords: [{ rawObservationId: "raw-a", rawArchiveId: "archive-a", snapshotParkDate: date }],
      normalizedRecords: []
    }),
    databaseSnapshot: null,
    databaseError: "validation database unavailable"
  });
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.excluded_dates, [date]);
  assert.ok(Object.values(report.checks).every((check) => check.passed === false));
  assert.equal(report.checks.lineage.verified, false);
});

test("global archive-count parity failure still excludes every file date", () => {
  const date = "2026-07-09";
  const rawRecords = [{
    rawObservationId: "raw-archive-count",
    rawArchiveId: "archive-a",
    snapshotParkDate: date,
    snapshotUtc: `${date}T17:00:00.000Z`,
    parkId: "dca",
    parkName: "Disney California Adventure",
    rideId: "ride-a",
    rideName: "Ride A",
    isOpen: true,
    waitTimeMinutes: 15
  }];
  const normalizedRecords = [{
    normalizedObservationId: "normalized-archive-count",
    rawObservationId: "raw-archive-count",
    canonicalAttractionId: "dca-ride-a",
    accessMode: "standby",
    isOpen: true,
    observedWaitTimeMinutes: 15,
    transformationVersion: "target-normalizer.v1"
  }];
  const archives = [{ rawArchiveId: "archive-a", sha256: "hash-a", sourceName: "archive-a.csv" }];
  const operatingWindows = [{
    date,
    parkId: "dca",
    openingTime: `${date}T16:00:00.000Z`,
    closingTime: `${date}T23:00:00.000Z`
  }];
  const file = buildFileParitySnapshot({ rawRecords, normalizedRecords, archives }, { operatingWindows });
  const database = buildDatabaseParitySnapshot({
    rawRows: rawRecords,
    normalizedRows: normalizedRecords,
    archives: [
      ...archives,
      { rawArchiveId: "unexpected-archive", sha256: "hash-extra", sourceName: "unexpected.csv" }
    ]
  }, { operatingWindows });

  const report = buildReplayParityReport({ plan: file, databaseSnapshot: database, operatingWindows, runId: "global-archive-count" });

  assert.equal(report.status, "blocked");
  assert.equal(report.checks.counts.mismatch_count, 1);
  assert.equal(report.checks.counts.mismatches[0].type, "raw_archive_count");
  assert.deepEqual(report.excluded_dates, [date]);
  assert.deepEqual(report.training_eligible_dates, []);
});

const rawFixture = `snapshot_utc,snapshot_park_datetime,snapshot_park_date,snapshot_timezone,park_id,park_name,land,ride_id,ride_name,is_open,wait_time_minutes,source_last_updated_utc,source_last_updated_park_datetime,source_url
2026-07-01T17:00:00.000Z,2026-07-01 10:00:00,2026-07-01,America/Los_Angeles,dca,Disney California Adventure,Grizzly Peak,ride-1,Soarin' Across America,TRUE,25,2026-07-01T16:58:00.000Z,2026-07-01 09:58:00,fixture://queue-times
2026-07-01T17:00:00.000Z,2026-07-01 10:00:00,2026-07-01,America/Los_Angeles,dca,Disney California Adventure,Grizzly Peak,ride-sr,Soarin' Across America Single Rider,TRUE,0,2026-07-01T16:58:00.000Z,2026-07-01 09:58:00,fixture://queue-times
2026-07-01T17:00:00.000Z,2026-07-01 10:00:00,2026-07-01,America/Los_Angeles,disneyland,Disneyland,Tomorrowland,closed-ride,Space Mountain,FALSE,0,2026-07-01T16:59:00.000Z,2026-07-01 09:59:00,fixture://queue-times
2026-07-01T17:15:00.000Z,2026-07-01 10:15:00,2026-07-01,America/Los_Angeles,dca,Disney California Adventure,Grizzly Peak,late-raw,Grizzly River Run,TRUE,35,2026-07-01T17:14:00.000Z,2026-07-01 10:14:00,fixture://queue-times
`;

const cleanedFixture = `snapshot_utc,snapshot_park_datetime,snapshot_park_date,snapshot_timezone,park_id,park_name,land,ride_id,ride_name,is_open,wait_time_minutes,source_last_updated_utc,source_last_updated_park_datetime,source_url,normalized_ride_name,base_ride_name,canonical_attraction_id,canonical_attraction_name,canonical_category,canonical_match_source,access_mode,is_single_rider,is_likely_entertainment,source_age_minutes,observed_wait_time_minutes,quality_flags,training_eligibility
2026-07-01T17:00:00.000Z,2026-07-01 10:00:00,2026-07-01,America/Los_Angeles,dca,Disney California Adventure,Grizzly Peak,ride-1,Soarin' Across America,TRUE,25,2026-07-01T16:58:00.000Z,2026-07-01 09:58:00,fixture://queue-times,soarin across america,Soarin' Across America,dca-soarin,Soarin',attraction,catalog_alias,standby,FALSE,FALSE,2,25,,standby_wait_model
2026-07-01T17:00:00.000Z,2026-07-01 10:00:00,2026-07-01,America/Los_Angeles,dca,Disney California Adventure,Grizzly Peak,ride-sr,Soarin' Across America Single Rider,TRUE,0,2026-07-01T16:58:00.000Z,2026-07-01 09:58:00,fixture://queue-times,soarin across america single rider,Soarin' Across America,dca-soarin,Soarin',attraction,catalog_alias,single_rider,TRUE,FALSE,2,0,open_zero,single_rider_availability_only
2026-07-01T17:00:00.000Z,2026-07-01 10:00:00,2026-07-01,America/Los_Angeles,disneyland,Disneyland,Tomorrowland,closed-ride,Space Mountain,FALSE,0,2026-07-01T16:59:00.000Z,2026-07-01 09:59:00,fixture://queue-times,space mountain,Space Mountain,disneyland-space-mountain,Space Mountain,attraction,auto_normalized,standby,FALSE,FALSE,1,,closed|possible_full_day_closed,status_model_only
`;

const aliasFixture = `park_id,alias_name,canonical_attraction_id,canonical_name,category,notes
dca,Soarin' Across America,dca-soarin,Soarin',attraction,Renamed versions share one canonical ID
`;

const replayRawFixture = `snapshot_utc,snapshot_park_datetime,snapshot_park_date,snapshot_timezone,park_id,park_name,land,ride_id,ride_name,is_open,wait_time_minutes,source_last_updated_utc,source_last_updated_park_datetime,source_url
2026-07-09T17:00:00.000Z,2026-07-09 10:00:00,2026-07-09,America/Los_Angeles,dca,Disney California Adventure,Grizzly Peak,ride-1,Soarin' Across America,TRUE,25,2026-07-09T16:58:00.000Z,2026-07-09 09:58:00,fixture://queue-times
2026-07-09T17:00:00.000Z,2026-07-09 10:00:00,2026-07-09,America/Los_Angeles,dca,Disney California Adventure,Grizzly Peak,ride-sr,Soarin' Across America Single Rider,TRUE,0,2026-07-09T16:58:00.000Z,2026-07-09 09:58:00,fixture://queue-times
2026-07-09T17:00:00.000Z,2026-07-09 10:00:00,2026-07-09,America/Los_Angeles,disneyland,Disneyland,Tomorrowland,open-missing,Space Mountain,TRUE,,2026-07-09T16:58:00.000Z,2026-07-09 09:58:00,fixture://queue-times
2026-07-09T17:00:00.000Z,2026-07-09 10:00:00,2026-07-09,America/Los_Angeles,disneyland,Disneyland,Fantasyland,closed-ride,Matterhorn Bobsleds,FALSE,0,2026-07-09T16:58:00.000Z,2026-07-09 09:58:00,fixture://queue-times
`;

function normalizedV2Fixture(overrides = {}) {
  return {
    contract_version: "normalized-wait-observation.v2",
    normalized_observation_id: "d".repeat(64),
    raw_observation_id: "a".repeat(64),
    operator_id: "disney",
    resort_id: "disneyland-resort",
    park_id: "disneyland-park",
    park_timezone: "America/Los_Angeles",
    observed_at_utc: "2026-09-24T17:15:00.000Z",
    canonical_attraction_id: "disneyland-space-mountain",
    canonical_attraction_name: "Space Mountain",
    canonical_category: "attraction",
    canonical_match_source: "catalog_alias",
    access_mode: "standby",
    is_open: true,
    observed_wait_time_minutes: 0,
    quality_flags: ["open_zero"],
    training_eligibility: "standby_wait_model",
    transformation_version: "target-normalizer.v2",
    generated_at: "2026-09-24T17:16:00.000Z",
    ...overrides
  };
}

function archiveLineReferenceFixture(hashCharacter = "c") {
  const archiveSha256 = hashCharacter.repeat(64);
  const sourceLineNumber = 2;
  return {
    contract_version: "raw-archive-line-reference.v1",
    raw_observation_id: calculateRawObservationId(archiveSha256, sourceLineNumber),
    raw_archive_id: "b".repeat(64),
    r2_uri: "s3://fixture-bucket/archives/fixture.csv",
    archive_sha256: archiveSha256,
    archive_byte_size: 384,
    source_line_number: sourceLineNumber,
    source_name: "fixture.csv",
    archive_schema_version: "raw-wait-observation.v1"
  };
}

function catalogEntryStorageFixture(canonicalAttractionId) {
  return {
    contract_version: "catalog-entry.v1",
    operator_id: "disney",
    resort_id: "disneyland-resort",
    park_id: "dca",
    aliases: ["Synthetic Storage Fixture Ride"],
    canonical_attraction_id: canonicalAttractionId,
    canonical_attraction_name: "Synthetic Storage Fixture Ride",
    canonical_category: "attraction",
    lifecycle: {
      contract_version: "catalog-attraction-lifecycle.v1",
      canonical_attraction_id: canonicalAttractionId,
      park_id: "dca",
      park_timezone: "America/Los_Angeles",
      wait_capability: "unknown",
      supported_access_modes: ["standby"],
      operational_state: "unknown",
      training_disposition: "review_required",
      planning_disposition: "review_required",
      evidence: [{
        source_type: "manual_review",
        source_url: null,
        verified_at: "2026-09-24T00:00:00.000Z",
        reviewed_by: "synthetic-storage-test",
        notes: "Synthetic fixture only; not production evidence."
      }],
      valid_from: "2026-01-01",
      valid_to: null,
      catalog_version: "catalog-storage-fixture.v1",
      generated_at: "2026-09-24T00:00:00.000Z"
    }
  };
}

function normalizedV2StorageFixture(reference, overrides = {}) {
  const transformationVersion = "storage-test-normalizer.v1";
  const record = {
    contract_version: "normalized-wait-observation.v2",
    normalized_observation_id: calculateNormalizedObservationId(reference.raw_observation_id, transformationVersion),
    raw_observation_id: reference.raw_observation_id,
    operator_id: "disney",
    resort_id: "disneyland-resort",
    park_id: "dca",
    park_timezone: "America/Los_Angeles",
    observed_at_utc: "2026-09-24T17:15:00.000Z",
    canonical_attraction_id: "dca-storage-fixture-ride",
    canonical_attraction_name: "Synthetic Storage Fixture Ride",
    canonical_category: "attraction",
    canonical_match_source: "alias_exact",
    access_mode: "standby",
    is_open: true,
    observed_wait_time_minutes: 25,
    quality_flags: [],
    training_eligibility: "review_required",
    transformation_version: transformationVersion,
    generated_at: "2026-09-24T18:00:00.000Z",
    ...overrides
  };
  return record;
}

function sourceHealthStorageFixture(runId) {
  return {
    source_health_id: "a".repeat(64),
    contract_version: "source-health.v1",
    source_name: "fixture-source",
    run_id: runId,
    envelope_id: "b".repeat(64),
    source_status: "ok",
    requested_at: "2026-09-24T17:00:00.000Z",
    observed_at: "2026-09-24T17:00:00.000Z",
    source_observed_at: null,
    ingested_at: "2026-09-24T17:01:00.000Z",
    source_age_minutes: 1,
    payload_sha256: "c".repeat(64),
    payload_byte_size: 384,
    record_count: 1,
    adapter_version: "fixture-source-adapter.v1",
    schema_version: "raw-wait-observation.v1",
    error_type: null,
    error_message: null,
    fallback_status: "written",
    hosted_write_status: "written",
    hosted_failure_reason: null,
    hosted_failure_message: null,
    generated_at: "2026-09-24T17:01:00.000Z"
  };
}

function createTransactionalFakePool({ seedNormalized = [] } = {}) {
  const queries = [];
  const normalizedFields = [
    "normalized_observation_id", "contract_version", "raw_observation_id", "operator_id", "resort_id",
    "park_id", "park_timezone", "observed_at_utc", "canonical_attraction_id", "canonical_attraction_name",
    "canonical_category", "canonical_match_source", "access_mode", "is_open", "observed_wait_time_minutes",
    "quality_flags", "training_eligibility", "transformation_version", "generated_at"
  ];
  const semanticFields = normalizedFields.filter((field) => field !== "generated_at");
  const referenceFields = [
    "contract_version", "raw_observation_id", "raw_archive_id", "r2_uri", "archive_sha256",
    "archive_byte_size", "source_line_number", "source_name", "archive_schema_version"
  ];
  const healthFields = [
    "source_health_id", "contract_version", "source_name", "run_id", "envelope_id", "source_status",
    "requested_at", "observed_at", "source_observed_at", "ingested_at", "source_age_minutes", "payload_sha256",
    "payload_byte_size", "record_count", "adapter_version", "schema_version", "error_type", "error_message",
    "fallback_status", "hosted_write_status", "hosted_failure_reason", "hosted_failure_message", "generated_at"
  ];
  const cloneMap = (map) => new Map([...map].map(([key, value]) => [key, structuredClone(value)]));
  const cloneState = (current) => ({
    references: cloneMap(current.references),
    normalized: cloneMap(current.normalized),
    catalogEntries: cloneMap(current.catalogEntries),
    sourceHealth: cloneMap(current.sourceHealth)
  });
  let committed = {
    references: new Map(),
    normalized: new Map(seedNormalized.map((record) => [record.normalized_observation_id, structuredClone(record)])),
    catalogEntries: new Map(),
    sourceHealth: new Map()
  };
  let working = null;

  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      const statement = sql.trim();
      if (statement === "BEGIN") {
        if (working) throw new Error("nested BEGIN is not supported by this fake PostgreSQL client");
        working = cloneState(committed);
        return { rows: [] };
      }
      if (statement === "COMMIT") {
        if (!working) throw new Error("COMMIT without caller transaction");
        committed = working;
        working = null;
        return { rows: [] };
      }
      if (statement === "ROLLBACK") {
        if (!working) throw new Error("ROLLBACK without caller transaction");
        working = null;
        return { rows: [] };
      }
      if (!working) throw new Error("storage repository query requires the caller-owned transaction");
      if (statement.includes("pg_advisory_xact_lock")) return { rows: [] };

      if (statement.includes("FROM ingestion.raw_archive_line_references")) {
        const row = working.references.get(params[0]);
        return { rows: row ? [structuredClone(row)] : [] };
      }
      if (statement.includes("INSERT INTO ingestion.raw_archive_line_references")) {
        const row = Object.fromEntries(referenceFields.map((field, index) => [field, params[index]]));
        working.references.set(row.raw_observation_id, row);
        return { rows: [] };
      }
      if (statement.includes("same_semantic_payload") && statement.includes("FROM observations.normalized_wait_observations_v2")) {
        const row = working.normalized.get(params[0]);
        if (!row) return { rows: [] };
        const existingSemanticValues = semanticFields.map((field) => row[field]);
        return {
          rows: [{
            same_semantic_payload: JSON.stringify(existingSemanticValues) === JSON.stringify(params.slice(1)),
            generated_at: row.generated_at
          }]
        };
      }
      if (statement.includes("INSERT INTO observations.normalized_wait_observations_v2")) {
        const row = Object.fromEntries(normalizedFields.map((field, index) => [field, params[index]]));
        if (!working.references.has(row.raw_observation_id)) {
          throw Object.assign(new Error("normalized row has no archive-line reference"), { code: "23503" });
        }
        working.normalized.set(row.normalized_observation_id, row);
        return { rows: [{ generated_at: row.generated_at }] };
      }
      if (statement.includes("FROM catalog.catalog_entry_snapshots")) {
        if (statement.includes("SELECT entry_document")) {
          const rows = [...working.catalogEntries.values()]
            .filter((entry) => entry.park_id === params[0] && entry.catalog_version === params[1])
            .map((entry) => ({ entry_document: entry.entry_document }));
          return { rows };
        }
        const entry = working.catalogEntries.get([params[0], params[1], params[2], params[3]].join("\u0000"));
        return { rows: entry ? [{ catalog_entry_id: entry.catalog_entry_id, entry_document: entry.entry_document }] : [] };
      }
      if (statement.includes("INSERT INTO catalog.catalog_entry_snapshots")) {
        const entry = {
          catalog_entry_id: params[0],
          contract_version: params[1],
          operator_id: params[2],
          resort_id: params[3],
          park_id: params[4],
          canonical_attraction_id: params[5],
          catalog_version: params[6],
          valid_from: params[7],
          valid_to: params[8],
          generated_at: params[9],
          entry_document: JSON.parse(params[10])
        };
        const key = [entry.park_id, entry.canonical_attraction_id, entry.catalog_version, entry.valid_from].join("\u0000");
        working.catalogEntries.set(key, entry);
        return { rows: [{ catalog_entry_id: entry.catalog_entry_id }] };
      }
      if (statement.includes("INSERT INTO ingestion.source_health")) {
        const health = Object.fromEntries(healthFields.map((field, index) => [field, params[index]]));
        working.sourceHealth.set(`${health.source_name}\u0000${health.run_id}`, health);
        return { rows: [] };
      }
      throw new Error(`Unexpected fake PostgreSQL query: ${statement}`);
    },
    release() {}
  };
  const pool = { async connect() { return client; } };
  return {
    pool,
    client,
    queries,
    get state() { return committed; }
  };
}

function createTransactionBoundaryPool({ beginError = null, commitError = null, rollbackError = null } = {}) {
  const queries = [];
  const releaseErrors = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql === "BEGIN" && beginError) throw beginError;
      if (sql === "COMMIT" && commitError) throw commitError;
      if (sql === "ROLLBACK" && rollbackError) throw rollbackError;
      return { rows: [] };
    },
    release(error) { releaseErrors.push(error); }
  };
  return {
    pool: { async connect() { return client; } },
    queries,
    releaseErrors
  };
}

function assertContractConformance(value, schema, location = "$") {
  if (schema.const !== undefined) assert.deepEqual(value, schema.const, `${location} must match const`);
  if (schema.enum) assert.ok(schema.enum.includes(value), `${location} must match enum`);

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    assert.ok(types.some((type) => matchesContractType(value, type)), `${location} has an invalid type`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined) assert.ok(value.length >= schema.minLength, `${location} is too short`);
    if (schema.pattern) assert.match(value, new RegExp(schema.pattern), `${location} does not match its pattern`);
    if (schema.format === "date-time") assert.ok(!Number.isNaN(Date.parse(value)), `${location} is not a date-time`);
  }
  if (typeof value === "number" && schema.minimum !== undefined) assert.ok(value >= schema.minimum, `${location} is below its minimum`);
  if (Array.isArray(value)) {
    if (schema.uniqueItems) assert.equal(new Set(value.map((item) => JSON.stringify(item))).size, value.length, `${location} contains duplicates`);
    if (schema.items) value.forEach((item, index) => assertContractConformance(item, schema.items, `${location}[${index}]`));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const required of schema.required || []) assert.ok(Object.hasOwn(value, required), `${location}.${required} is required`);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) assert.ok(schema.properties?.[key], `${location}.${key} is not allowed`);
    }
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, key)) assertContractConformance(value[key], childSchema, `${location}.${key}`);
    }
  }
  for (const branch of schema.allOf || []) {
    if (!branch.if || matchesContractSchema(value, branch.if)) {
      if (branch.then) assertContractConformance(value, branch.then, location);
      if (branch.else) assertContractConformance(value, branch.else, location);
    }
  }
}

function matchesContractSchema(value, schema) {
  if (schema.const !== undefined && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesContractType(value, type))) return false;
  }
  if (schema.required?.some((field) => !Object.hasOwn(value, field))) return false;
  return Object.entries(schema.properties || {}).every(([key, childSchema]) => !Object.hasOwn(value, key) || matchesContractSchema(value[key], childSchema));
}

function matchesContractType(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}
