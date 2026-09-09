import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildBackfillPlan, transformationVersion } from "../../infra/backfill/wait-time-records.mjs";

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
