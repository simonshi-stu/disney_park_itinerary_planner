import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildBackfillPlan, transformationVersion, replayTransformationVersion } from "../../infra/backfill/wait-time-records.mjs";
import { buildDatabaseParitySnapshot, buildFileParitySnapshot, buildReplayParityReport, queryDatabaseSnapshot } from "../../scripts/report-replay-parity.mjs";

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
