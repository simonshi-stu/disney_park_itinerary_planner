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
