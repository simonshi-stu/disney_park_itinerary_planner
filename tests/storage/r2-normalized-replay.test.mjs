import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildOfflineReplayCheckReport,
  createPostgresR2ReplayDatabase,
  replayR2ArchivesToNormalized,
  r2ReplayTransformationVersion
} from "../../infra/backfill/r2-normalized-records.mjs";
import { calculateRawObservationId } from "../../infra/archive-line-reference-postgres.mjs";
import { runReplayOfflineCheck } from "../../scripts/replay-r2-archives-to-normalized.mjs";

const generatedAt = "2026-09-26T12:00:00.000Z";
const rawCountBaseline = 440;
const NORMALIZED_FIELDS = [
  "normalized_observation_id", "contract_version", "raw_observation_id", "operator_id", "resort_id",
  "park_id", "park_timezone", "observed_at_utc", "canonical_attraction_id", "canonical_attraction_name",
  "canonical_category", "canonical_match_source", "access_mode", "is_open", "observed_wait_time_minutes",
  "quality_flags", "training_eligibility", "transformation_version", "generated_at"
];
const SEMANTIC_FIELDS = NORMALIZED_FIELDS.filter((field) => field !== "generated_at");
const REFERENCE_FIELDS = [
  "contract_version", "raw_observation_id", "raw_archive_id", "r2_uri", "archive_sha256",
  "archive_byte_size", "source_line_number", "source_name", "archive_schema_version"
];
const HEALTH_FIELDS = [
  "source_health_id", "contract_version", "source_name", "run_id", "envelope_id", "source_status",
  "requested_at", "observed_at", "source_observed_at", "ingested_at", "source_age_minutes", "payload_sha256",
  "payload_byte_size", "record_count", "adapter_version", "schema_version", "error_type", "error_message",
  "fallback_status", "hosted_write_status", "hosted_failure_reason", "hosted_failure_message", "generated_at"
];

test("replay verifies archive lineage, composes all 04d3 ports atomically, and never inserts raw rows", async () => {
  const fixture = makeArchive([
    row("ride-standby", "Fixture, Ride", true, 25),
    row("ride-single", "Fixture, Ride Single Rider", true, 0)
  ]);
  const fake = createFakeDatabase();
  const report = await replayR2ArchivesToNormalized(writeOptions(fixture, fake));

  assert.equal(report.status, "completed");
  assert.equal(report.write_enabled, true);
  assert.equal(report.counts.archives_verified, 1);
  assert.equal(report.counts.data_rows, 2);
  assert.equal(report.counts.normalized_records_planned, 2);
  assert.equal(report.counts.normalized_records_committed, 2);
  assert.equal(report.counts.batches_committed, 1);
  assert.equal(fake.committed.references.size, 2);
  assert.equal(fake.committed.catalogEntries.size, 1);
  assert.equal(fake.committed.normalized.size, 2);
  assert.equal(fake.committed.sourceHealth.size, 1);
  const health = [...fake.committed.sourceHealth.values()][0];
  const expectedBatchManifest = [...fake.committed.references.values()]
    .sort((left, right) => left.source_line_number - right.source_line_number)
    .map((reference) => reference.raw_observation_id)
    .join("\n");
  assert.equal(health.payload_sha256, createHash("sha256").update(expectedBatchManifest).digest("hex"));
  assert.equal(health.payload_byte_size, Buffer.byteLength(expectedBatchManifest));
  assert.equal(fake.committed.rawObservationCount, rawCountBaseline);
  assert.equal(fake.rawInsertAttempts, 0);
  assert.equal(fake.queries.filter(({ sql }) => sql.trim() === "BEGIN").length, 1);
  assert.equal(fake.queries.filter(({ sql }) => sql.trim() === "COMMIT").length, 1);
  assert.equal(fake.queries.filter(({ sql }) => sql.trim() === "ROLLBACK").length, 0);
  assert.ok(fake.queries.some(({ sql }) => /FROM ingestion\.raw_archive_line_references\s+WHERE raw_observation_id\s*=\s*\$1/i.test(sql)));
  assert.ok(fake.queries.every(({ sql }) => !/WHERE\s+archive_sha256/i.test(sql)));
  assert.ok(fake.queries.every(({ sql }) => !/INSERT\s+INTO\s+ingestion\.raw_wait_observations/i.test(sql)));

  const refs = [...fake.committed.references.values()].sort((a, b) => a.source_line_number - b.source_line_number);
  assert.deepEqual(refs.map((reference) => reference.source_line_number), [1, 2], "header is excluded from data-row ordinals");
  assert.deepEqual(refs.map((reference) => reference.raw_observation_id), [
    calculateRawObservationId(fixture.archive.sha256, 1),
    calculateRawObservationId(fixture.archive.sha256, 2)
  ]);
  const normalized = [...fake.committed.normalized.values()].sort((a, b) => a.observed_at_utc.localeCompare(b.observed_at_utc));
  assert.deepEqual(normalized.map((record) => record.access_mode), ["standby", "single_rider"]);
  assert.equal(normalized[0].transformation_version, r2ReplayTransformationVersion);
  assert.equal(report.raw_observation_baseline.unchanged, true);
});

test("archive hash, metadata, schema, and size are verified before parsing and before any write", async () => {
  const fixture = makeArchive([row("ride-standby", "Fixture Ride", true, 25)]);
  const invalidObjects = [
    { label: "hash", options: { body: Buffer.from("malformed \" CSV") }, expected: "ARCHIVE_SHA256_MISMATCH" },
    { label: "hash metadata", options: { metadataSha256: "f".repeat(64) }, expected: "ARCHIVE_SHA256_MISMATCH" },
    { label: "schema metadata", options: { metadataSchemaVersion: "other.v1" }, expected: "ARCHIVE_SCHEMA_METADATA_MISMATCH" },
    { label: "immutability", options: { immutable: false }, expected: "R2_OBJECT_METADATA_OR_IMMUTABILITY_MISSING" },
    { label: "size", options: { contentLength: fixture.archive.byte_size + 1 }, expected: "ARCHIVE_BYTE_SIZE_MISMATCH" }
  ];

  for (const invalid of invalidObjects) {
    const fake = createFakeDatabase();
    const r2 = makeFakeR2(fixture, invalid.options);
    const report = await replayR2ArchivesToNormalized(writeOptions(fixture, fake, { r2 }));
    assert.equal(report.status, "blocked", invalid.label);
    assert.equal(report.diagnostics.archive_failures.samples[0].code, invalid.expected, invalid.label);
    assert.equal(fake.transactionCount, 0, `${invalid.label} mismatch must precede all writes`);
    assert.equal(fake.committed.references.size, 0);
  }
});

test("unresolved identities and missing explicit modes block the whole scope before writes", async () => {
  const fixture = makeArchive([
    row("ride-no-mode", "Fixture Ride Single Rider", true, 15),
    row("ride-unknown", "Unmapped Attraction", true, 20)
  ]);
  const fake = createFakeDatabase();
  const mapping = accessModeMapping([
    { park_id: "dca", ride_id: "ride-unknown", access_mode: "standby" }
  ]);
  const report = await replayR2ArchivesToNormalized(writeOptions(fixture, fake, { accessModeMapping: mapping }));

  assert.equal(report.status, "blocked");
  assert.equal(report.write_enabled, false);
  assert.equal(report.counts.unresolved_identities, 1);
  assert.equal(report.counts.missing_access_modes, 1, "a name suffix never supplies an access mode");
  assert.equal(fake.transactionCount, 0);
  assert.equal(fake.readOnlyCountCalls, 0, "scope errors are resolved before database baseline checks");
  assert.equal(fake.committed.references.size, 0);
});

test("dry-run uses only injected read-only ports and never opens the transaction writer", async () => {
  const fixture = makeArchive([row("ride-standby", "Fixture Ride", true, 25)]);
  const fake = createFakeDatabase();
  const report = await replayR2ArchivesToNormalized({
    ...writeOptions(fixture, fake),
    mode: "dry-run",
    authorization: undefined,
    capacityGate: undefined,
    capacityMonitor: undefined
  });

  assert.equal(report.status, "dry_run_complete");
  assert.equal(report.counts.normalized_records_planned, 1);
  assert.equal(report.write_enabled, false);
  assert.ok(report.write_blockers.includes("measured_capacity_preflight_required"));
  assert.equal(fake.transactionCount, 0);
  assert.equal(fake.readOnlyCountCalls, 2);
  assert.equal(report.raw_observation_baseline.unchanged, true);
  assert.equal(fake.rawInsertAttempts, 0);
});

test("a failed row write rolls back catalog and archive references in the same batch transaction", async () => {
  const fixture = makeArchive([row("ride-standby", "Fixture Ride", true, 25)]);
  const fake = createFakeDatabase({ failNormalizedInsert: true });
  const report = await replayR2ArchivesToNormalized(writeOptions(fixture, fake));

  assert.equal(report.status, "failed");
  assert.equal(report.counts.batches_committed, 0);
  assert.equal(report.diagnostics.runtime_failures.samples[0].code, "FAKE_NORMALIZED_INSERT_FAILED");
  assert.equal(fake.transactionCount, 1);
  assert.equal(fake.queries.filter(({ sql }) => sql.trim() === "ROLLBACK").length, 1);
  assert.equal(fake.committed.references.size, 0);
  assert.equal(fake.committed.catalogEntries.size, 0);
  assert.equal(fake.committed.normalized.size, 0);
  assert.equal(fake.committed.sourceHealth.size, 0);
  assert.equal(fake.rawInsertAttempts, 0);
  assert.equal(report.raw_observation_baseline.unchanged, true);
});

test("replay retry preserves first generated_at and a changed access mode conflicts immutably", async () => {
  const fixture = makeArchive([row("ride-standby", "Fixture Ride", true, 25)]);
  const fake = createFakeDatabase();
  const initial = await replayR2ArchivesToNormalized(writeOptions(fixture, fake, { runId: "retry-run" }));
  const firstGeneratedAt = [...fake.committed.normalized.values()][0].generated_at;
  const retry = await replayR2ArchivesToNormalized(writeOptions(fixture, fake, {
    runId: "retry-run-2",
    generatedAt: "2026-09-27T10:00:00.000Z"
  }));

  assert.equal(initial.status, "completed");
  assert.equal(retry.status, "completed");
  assert.equal([...fake.committed.normalized.values()][0].generated_at, firstGeneratedAt);
  assert.equal(fake.queries.filter(({ sql }) => sql.includes("INSERT INTO observations.normalized_wait_observations_v2")).length, 1);

  const changedAccess = accessModeMapping([
    { park_id: "dca", ride_id: "ride-standby", access_mode: "single_rider" }
  ]);
  const conflict = await replayR2ArchivesToNormalized(writeOptions(fixture, fake, {
    accessModeMapping: changedAccess,
    runId: "retry-conflict"
  }));
  assert.equal(conflict.status, "failed");
  assert.equal(conflict.diagnostics.runtime_failures.samples[0].code, "NORMALIZED_OBSERVATION_CONFLICT");
  assert.equal([...fake.committed.normalized.values()][0].access_mode, "standby");
  assert.equal([...fake.committed.normalized.values()][0].generated_at, firstGeneratedAt);
  assert.equal(fake.committed.sourceHealth.size, 1, "the conflicting batch is rolled back before source health");
  assert.equal(fake.rawInsertAttempts, 0);
});

test("capacity stop pauses after a bounded batch and a later invocation resumes by stable cursor", async () => {
  const fixture = makeArchive([
    row("ride-1", "Fixture Ride", true, 15),
    row("ride-2", "Fixture Ride", true, 20),
    row("ride-3", "Fixture Ride", true, 25)
  ]);
  const fake = createFakeDatabase();
  const usages = [100, 100, 120, 140];
  const capacityMonitor = { async readUsedBytes() { return usages.shift() ?? 140; } };
  const first = await replayR2ArchivesToNormalized(writeOptions(fixture, fake, {
    accessModeMapping: accessModeMapping([
      { park_id: "dca", ride_id: "ride-1", access_mode: "standby" },
      { park_id: "dca", ride_id: "ride-2", access_mode: "standby" },
      { park_id: "dca", ride_id: "ride-3", access_mode: "standby" }
    ]),
    capacityGate: capacityGate({ stopThresholdBytes: 150, estimatedBytesPerRecord: 10 }),
    capacityMonitor,
    batchSize: 1,
    maxBatches: 5,
    runId: "bounded-run"
  }));

  assert.equal(first.status, "paused");
  assert.equal(first.stop_reason, "capacity_stop_threshold_would_be_reached");
  assert.equal(first.counts.normalized_records_committed, 1);
  assert.deepEqual(first.next_cursor, {
    scope_id: first.scope_id,
    raw_archive_id: fixture.archive.raw_archive_id,
    next_data_row_ordinal: 2
  });
  assert.equal(fake.committed.normalized.size, 1);

  const mismatchedScope = await replayR2ArchivesToNormalized(writeOptions(fixture, fake, {
    accessModeMapping: accessModeMapping([
      { park_id: "dca", ride_id: "ride-1", access_mode: "single_rider" },
      { park_id: "dca", ride_id: "ride-2", access_mode: "standby" },
      { park_id: "dca", ride_id: "ride-3", access_mode: "standby" }
    ]),
    capacityGate: capacityGate({ stopThresholdBytes: 1000, estimatedBytesPerRecord: 10 }),
    capacityMonitor: { async readUsedBytes() { return 200; } },
    batchSize: 1,
    maxBatches: 5,
    resumeFrom: first.next_cursor,
    runId: "bounded-resume-changed-scope"
  }));
  assert.equal(mismatchedScope.status, "blocked");
  assert.ok(mismatchedScope.blockers.includes("resume_cursor_scope_mismatch"));
  assert.equal(fake.transactionCount, 1, "scope mismatch must not open another write transaction");

  const resumed = await replayR2ArchivesToNormalized(writeOptions(fixture, fake, {
    accessModeMapping: accessModeMapping([
      { park_id: "dca", ride_id: "ride-1", access_mode: "standby" },
      { park_id: "dca", ride_id: "ride-2", access_mode: "standby" },
      { park_id: "dca", ride_id: "ride-3", access_mode: "standby" }
    ]),
    capacityGate: capacityGate({ stopThresholdBytes: 1000, estimatedBytesPerRecord: 10 }),
    capacityMonitor: { async readUsedBytes() { return 200; } },
    batchSize: 1,
    maxBatches: 5,
    resumeFrom: first.next_cursor,
    runId: "bounded-resume"
  }));
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.counts.normalized_records_committed, 2);
  assert.equal(fake.committed.normalized.size, 3);
  assert.equal(fake.rawInsertAttempts, 0);
});

test("missing or invalid capacity measurements block before opening a write transaction", async () => {
  const fixture = makeArchive([row("ride-standby", "Fixture Ride", true, 25)]);
  const fake = createFakeDatabase();
  const report = await replayR2ArchivesToNormalized(writeOptions(fixture, fake, {
    capacityMonitor: { async readUsedBytes() { return Number.NaN; } }
  }));

  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("capacity_preflight_measurement_invalid"));
  assert.equal(fake.transactionCount, 0);
  assert.equal(fake.committed.normalized.size, 0);
  assert.equal(report.raw_observation_baseline.unchanged, true);
});

test("offline CLI check report is explicitly blocked without fabricating replay readiness", () => {
  const report = buildOfflineReplayCheckReport({ checkedAt: generatedAt });
  assert.equal(report.status, "blocked");
  assert.equal(report.write_enabled, false);
  assert.equal(report.external_connections_opened, false);
  assert.ok(report.blockers.includes("reviewed_catalog_snapshot_not_supplied"));
  assert.ok(report.blockers.includes("reviewed_structured_access_mode_mapping_not_supplied"));
  assert.ok(report.blockers.includes("measured_capacity_preflight_and_stop_threshold_not_supplied"));
});

test("a failed second-pass re-read returns a scope-bound cursor that resumes without data loss", async () => {
  const fixture = makeArchive([
    row("ride-standby", "Fixture Ride", true, 25),
    row("ride-standby", "Fixture Ride", true, 30)
  ]);
  const fake = createFakeDatabase();
  let reads = 0;
  const flaky = {
    async getObject(uri) {
      reads += 1;
      if (reads === 2) throw new Error("synthetic transient read failure");
      return fixture.r2.getObject(uri);
    }
  };

  const failed = await replayR2ArchivesToNormalized(writeOptions(fixture, fake, { r2: flaky }));
  assert.equal(failed.status, "failed");
  assert.equal(failed.stop_reason, "archive_reverification_failed");
  assert.deepEqual(failed.next_cursor, {
    scope_id: failed.scope_id,
    raw_archive_id: fixture.archive.raw_archive_id,
    next_data_row_ordinal: 1
  });
  assert.equal(fake.transactionCount, 0);

  const resumed = await replayR2ArchivesToNormalized(writeOptions(fixture, fake, {
    resumeFrom: failed.next_cursor
  }));
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.counts.normalized_records_committed, 2);
  assert.equal(fake.committed.normalized.size, 2);
  assert.equal(fake.rawInsertAttempts, 0);
});

test("source-health run ids stay stable per replay scope and batch boundaries across pause and retry", async () => {
  const fixture = makeArchive([
    row("ride-standby", "Fixture Ride", true, 10),
    row("ride-standby", "Fixture Ride", true, 20),
    row("ride-standby", "Fixture Ride", true, 30)
  ]);
  const fake = createFakeDatabase();
  const shared = {
    capacityGate: capacityGate({ stopThresholdBytes: 1000, estimatedBytesPerRecord: 10 }),
    capacityMonitor: { async readUsedBytes() { return 100; } },
    batchSize: 1
  };
  const first = await replayR2ArchivesToNormalized(writeOptions(fixture, fake, {
    ...shared,
    maxBatches: 1,
    runId: "invocation-one"
  }));
  assert.equal(first.status, "paused");
  assert.equal(fake.committed.sourceHealth.size, 1);

  const resumed = await replayR2ArchivesToNormalized(writeOptions(fixture, fake, {
    ...shared,
    maxBatches: 5,
    resumeFrom: first.next_cursor,
    runId: "invocation-two"
  }));
  assert.equal(resumed.status, "completed");
  assert.equal(fake.committed.sourceHealth.size, 3, "each batch keeps its own row across pause/resume");
  for (const health of fake.committed.sourceHealth.values()) {
    assert.equal(health.record_count, 1);
    assert.ok(health.run_id.startsWith("r2-normalized-replay:"));
    assert.ok(health.run_id.includes(first.scope_id), "run id binds the replay scope");
    assert.ok(!health.run_id.includes("invocation-one"));
    assert.ok(!health.run_id.includes("invocation-two"));
  }

  const snapshot = () => [...fake.committed.sourceHealth.entries()]
    .map(([key, value]) => [key, {
      source_health_id: value.source_health_id,
      envelope_id: value.envelope_id,
      payload_sha256: value.payload_sha256,
      record_count: value.record_count
    }]);
  const beforeRetry = snapshot();
  const retry = await replayR2ArchivesToNormalized(writeOptions(fixture, fake, {
    ...shared,
    maxBatches: 5,
    runId: "invocation-three"
  }));
  assert.equal(retry.status, "completed");
  assert.equal(fake.committed.sourceHealth.size, 3, "an identical retry is idempotent and never overwrites another batch row");
  assert.deepEqual(snapshot(), beforeRetry);
});

test("resume preflight verifies only remaining archives and reports skipped inventory", async () => {
  const firstFixture = makeArchive([row("ride-1", "Fixture Ride", true, 10)]);
  const secondFixture = makeArchive([row("ride-2", "Fixture Ride", true, 20)]);
  const ordered = [firstFixture, secondFixture].sort((left, right) =>
    left.archive.raw_archive_id.localeCompare(right.archive.raw_archive_id));
  const accessModes = accessModeMapping([
    { park_id: "dca", ride_id: "ride-1", access_mode: "standby" },
    { park_id: "dca", ride_id: "ride-2", access_mode: "standby" }
  ]);
  const fake = createFakeDatabase();
  const archives = ordered.map(({ archive }) => archive);
  const firstReader = makeMultiFakeR2([firstFixture, secondFixture]);
  const first = await replayR2ArchivesToNormalized(writeOptions(firstFixture, fake, {
    archives,
    r2: firstReader,
    accessModeMapping: accessModes,
    capacityGate: capacityGate({ stopThresholdBytes: 1000, estimatedBytesPerRecord: 10 }),
    capacityMonitor: { async readUsedBytes() { return 100; } },
    batchSize: 1,
    maxBatches: 1,
    runId: "first-invocation"
  }));
  assert.equal(first.status, "paused");
  assert.equal(first.counts.archives_verified, 2);
  assert.deepEqual(first.resume.archives_skipped_before_cursor, []);
  assert.equal(first.next_cursor.raw_archive_id, ordered[1].archive.raw_archive_id);

  const resumeReader = makeMultiFakeR2([firstFixture, secondFixture]);
  const resumed = await replayR2ArchivesToNormalized(writeOptions(firstFixture, fake, {
    archives,
    r2: resumeReader,
    accessModeMapping: accessModes,
    capacityGate: capacityGate({ stopThresholdBytes: 1000, estimatedBytesPerRecord: 10 }),
    capacityMonitor: { async readUsedBytes() { return 100; } },
    batchSize: 1,
    maxBatches: 5,
    resumeFrom: first.next_cursor,
    runId: "second-invocation"
  }));

  assert.equal(resumed.status, "completed");
  assert.equal(resumed.counts.archives_verified, 1);
  assert.deepEqual(resumed.resume.archives_skipped_before_cursor, [ordered[0].archive.raw_archive_id]);
  assert.deepEqual(resumed.resume.archives_preflighted_this_invocation, [ordered[1].archive.raw_archive_id]);
  assert.equal(resumeReader.calls.includes(ordered[0].archive.object_uri), false, "prior archive is not fetched on resume");
  assert.ok(resumeReader.calls.includes(ordered[1].archive.object_uri));
  assert.equal(fake.committed.normalized.size, 2);
});

test("stale or future capacity measurements block before any write", async () => {
  const fixture = makeArchive([row("ride-standby", "Fixture Ride", true, 25)]);

  const staleFake = createFakeDatabase();
  const stale = await replayR2ArchivesToNormalized(writeOptions(fixture, staleFake, {
    capacityGate: capacityGate({ measuredAt: "2026-09-25T11:59:59.999Z" })
  }));
  assert.equal(stale.status, "blocked");
  assert.ok(stale.blockers.includes("capacity_measurement_stale_relative_to_generated_at"));
  assert.equal(staleFake.transactionCount, 0);

  const futureFake = createFakeDatabase();
  const future = await replayR2ArchivesToNormalized(writeOptions(fixture, futureFake, {
    capacityGate: capacityGate({ measuredAt: "2026-09-26T12:00:00.001Z" })
  }));
  assert.equal(future.status, "blocked");
  assert.ok(future.blockers.includes("capacity_measurement_future_relative_to_generated_at"));
  assert.equal(futureFake.transactionCount, 0);

  const boundary = await replayR2ArchivesToNormalized(writeOptions(fixture, createFakeDatabase(), {
    capacityGate: capacityGate({ measuredAt: "2026-09-25T12:00:00.000Z" })
  }));
  assert.equal(boundary.status, "completed", "a measurement exactly at the age limit remains usable");
});

test("archive descriptor raw_archive_id must equal the verified content sha256", async () => {
  const fixture = makeArchive([row("ride-standby", "Fixture Ride", true, 25)]);
  const fake = createFakeDatabase();
  const report = await replayR2ArchivesToNormalized(writeOptions(fixture, fake, {
    archives: [{ ...fixture.archive, raw_archive_id: "f".repeat(64) }]
  }));

  assert.equal(report.status, "blocked");
  assert.equal(report.diagnostics.archive_failures.samples[0].code, "INVALID_ARCHIVE_DESCRIPTOR");
  assert.ok(report.blockers.includes("no_valid_archive_descriptors"));
  assert.equal(fake.transactionCount, 0);
});

test("offline CLI accepts only --check and opens no connections", () => {
  let stdout = "";
  let stderr = "";
  const io = {
    writeStdout: (text) => { stdout += text; },
    writeStderr: (text) => { stderr += text; }
  };

  assert.equal(runReplayOfflineCheck(["--check"], io), 0);
  const report = JSON.parse(stdout);
  assert.equal(report.mode, "offline_check");
  assert.equal(report.external_connections_opened, false);
  assert.equal(report.write_enabled, false);

  stdout = "";
  stderr = "";
  assert.equal(runReplayOfflineCheck(["--dry-run"], io), 2, "--dry-run is not a supported offline CLI command");
  assert.equal(stdout, "");
  assert.match(stderr, /--check/);
  assert.equal(runReplayOfflineCheck([], io), 2);
});

test("cross-entry alias ambiguity blocks the reviewed scope once instead of per row", async () => {
  const fixture = makeArchive([row("ride-standby", "Fixture Ride", true, 25)]);
  const snapshot = catalogSnapshot();
  const conflicting = structuredClone(snapshot.entries[0]);
  conflicting.canonical_attraction_id = "dca-fixture-ride-duplicate";
  conflicting.canonical_attraction_name = "Fixture Ride Duplicate";
  conflicting.lifecycle.canonical_attraction_id = "dca-fixture-ride-duplicate";
  snapshot.entries.push(conflicting);

  const fake = createFakeDatabase();
  const r2 = makeFakeR2(fixture);
  const report = await replayR2ArchivesToNormalized(writeOptions(fixture, fake, {
    catalogSnapshot: snapshot,
    r2
  }));

  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("reviewed_catalog_snapshot_cross_entry_alias_ambiguity"));
  assert.equal(fake.transactionCount, 0);
  assert.equal(r2.calls.length, 0, "the ambiguous scope fails before any archive read");
});

test("r2-normalized-replay-report.v1 schema covers the replay and offline-check variants", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const schema = JSON.parse(await readFile(
    path.join(root, "packages/contracts/schemas/v1/r2-normalized-replay-report.schema.json"),
    "utf8"
  ));
  assert.equal(schema.$id, "https://disney-park-itinerary-planner.local/contracts/v1/r2-normalized-replay-report.schema.json");
  assert.equal(schema.oneOf.length, 2);

  const offline = buildOfflineReplayCheckReport({ checkedAt: generatedAt });
  assertSchemaConformance(offline, schema);

  const fixture = makeArchive([row("ride-standby", "Fixture Ride", true, 25)]);
  const replay = await replayR2ArchivesToNormalized(writeOptions(fixture, createFakeDatabase()));
  assert.equal(replay.status, "completed");
  assertSchemaConformance(replay, schema);

  assert.throws(() => assertSchemaConformance({ ...offline, write_enabled: true }, schema));
  assert.throws(() => assertSchemaConformance({ ...replay, counts: { ...replay.counts, archives_verified: -1 } }, schema));
});

function writeOptions(fixture, fake, overrides = {}) {
  return {
    mode: "write",
    archives: overrides.archives || [fixture.archive],
    r2: overrides.r2 || fixture.r2,
    database: fake.database,
    catalogSnapshot: overrides.catalogSnapshot || catalogSnapshot(),
    accessModeMapping: overrides.accessModeMapping || accessModeMapping([
      { park_id: "dca", ride_id: "ride-standby", access_mode: "standby" },
      { park_id: "dca", ride_id: "ride-single", access_mode: "single_rider" }
    ]),
    generatedAt: overrides.generatedAt || generatedAt,
    runId: overrides.runId || "replay-test-run",
    authorization: { kind: "validation-only", approvedBy: "synthetic-test-reviewer", approvedAt: generatedAt },
    capacityGate: overrides.capacityGate || capacityGate(),
    capacityMonitor: overrides.capacityMonitor || { async readUsedBytes() { return 100; } },
    batchSize: overrides.batchSize ?? 100,
    maxBatches: overrides.maxBatches ?? 2,
    resumeFrom: overrides.resumeFrom ?? null
  };
}

function makeArchive(rows, objectOverrides = {}) {
  const content = Buffer.from(makeCsv(rows), "utf8");
  const sha256 = createHash("sha256").update(content).digest("hex");
  const archive = {
    contract_version: "raw-archive.v1",
    raw_archive_id: sha256,
    object_uri: `s3://replay-fixture/wait-times/${sha256}/fixture.csv`,
    sha256,
    byte_size: content.byteLength,
    source_name: "fixture.csv",
    schema_version: "raw-wait-observation.v1"
  };
  return { archive, r2: makeFakeR2({ archive, content }, objectOverrides), content };
}

function makeFakeR2(fixture, overrides = {}) {
  const calls = [];
  return {
    calls,
    async getObject(uri) {
      calls.push(uri);
      const body = overrides.body || fixture.content;
      return {
        r2_uri: uri,
        immutable: overrides.immutable ?? true,
        body,
        contentLength: overrides.contentLength ?? body.byteLength,
        metadata: {
          sha256: overrides.metadataSha256 || fixture.archive.sha256,
          schema_version: overrides.metadataSchemaVersion || fixture.archive.schema_version
        }
      };
    }
  };
}

function makeCsv(rows) {
  const columns = [
    "snapshot_utc", "snapshot_park_datetime", "snapshot_park_date", "snapshot_timezone", "park_id",
    "park_name", "land", "ride_id", "ride_name", "is_open", "wait_time_minutes",
    "source_last_updated_utc", "source_last_updated_park_datetime", "source_url"
  ];
  const values = rows.map((value, index) => ({
    snapshot_utc: `2026-09-24T17:${String(15 + index).padStart(2, "0")}:00.000Z`,
    snapshot_park_datetime: `2026-09-24 10:${String(15 + index).padStart(2, "0")}:00`,
    snapshot_park_date: "2026-09-24",
    snapshot_timezone: "America/Los_Angeles",
    park_id: "dca",
    park_name: "Disney California Adventure",
    land: "Fixture Land",
    ride_id: value.rideId,
    ride_name: value.rideName,
    is_open: value.isOpen ? "TRUE" : "FALSE",
    wait_time_minutes: value.wait === null ? "" : String(value.wait),
    source_last_updated_utc: `2026-09-24T17:${String(14 + index).padStart(2, "0")}:00.000Z`,
    source_last_updated_park_datetime: `2026-09-24 10:${String(14 + index).padStart(2, "0")}:00`,
    source_url: "fixture://queue-times"
  }));
  const encode = (value) => {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `${columns.join(",")}\r\n${values.map((record) => columns.map((column) => encode(record[column])).join(",")).join("\r\n")}\r\n`;
}

function row(rideId, rideName, isOpen, wait) {
  return { rideId, rideName, isOpen, wait };
}

function catalogSnapshot() {
  return {
    status: "reviewed",
    catalog_version: "synthetic-replay-catalog.v1",
    reviewed_by: "synthetic-test-reviewer",
    reviewed_at: generatedAt,
    entries: [{
      contract_version: "catalog-entry.v1",
      operator_id: "disney",
      resort_id: "disneyland-resort",
      park_id: "dca",
      aliases: ["Fixture Ride", "Fixture, Ride"],
      canonical_attraction_id: "dca-fixture-ride",
      canonical_attraction_name: "Fixture Ride",
      canonical_category: "attraction",
      lifecycle: {
        contract_version: "catalog-attraction-lifecycle.v1",
        canonical_attraction_id: "dca-fixture-ride",
        park_id: "dca",
        park_timezone: "America/Los_Angeles",
        wait_capability: "unknown",
        supported_access_modes: ["standby", "single_rider"],
        operational_state: "unknown",
        training_disposition: "review_required",
        planning_disposition: "review_required",
        evidence: [{
          source_type: "manual_review",
          source_url: null,
          verified_at: generatedAt,
          reviewed_by: "synthetic-test-reviewer",
          notes: "Synthetic fixture only; not authoritative park evidence."
        }],
        valid_from: "2026-01-01",
        valid_to: null,
        catalog_version: "synthetic-replay-catalog.v1",
        generated_at: generatedAt
      }
    }]
  };
}

function accessModeMapping(mappings) {
  return {
    status: "reviewed",
    catalog_version: "synthetic-replay-catalog.v1",
    reviewed_by: "synthetic-test-reviewer",
    reviewed_at: generatedAt,
    mappings
  };
}

function capacityGate(overrides = {}) {
  return {
    approved: true,
    targetLabel: "neon-validation-branch-only",
    measurementId: "synthetic-measurement-only",
    measuredAt: generatedAt,
    maxCapacityBytes: 1_000_000,
    reservedHeadroomBytes: 10_000,
    stopThresholdBytes: 900_000,
    estimatedBytesPerRecord: 10,
    ...overrides
  };
}

function createFakeDatabase({ failNormalizedInsert = false } = {}) {
  const queries = [];
  let transactionCount = 0;
  let readOnlyCountCalls = 0;
  let rawInsertAttempts = 0;
  const cloneMap = (map) => new Map([...map].map(([key, value]) => [key, structuredClone(value)]));
  const cloneState = (state) => ({
    references: cloneMap(state.references),
    catalogEntries: cloneMap(state.catalogEntries),
    normalized: cloneMap(state.normalized),
    sourceHealth: cloneMap(state.sourceHealth),
    rawObservationCount: state.rawObservationCount
  });
  let committed = {
    references: new Map(),
    catalogEntries: new Map(),
    normalized: new Map(),
    sourceHealth: new Map(),
    rawObservationCount: rawCountBaseline
  };
  let working = null;
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      const statement = sql.trim();
      if (statement === "BEGIN") {
        transactionCount += 1;
        if (working) throw new Error("nested transaction in replay fake");
        working = cloneState(committed);
        return { rows: [] };
      }
      if (statement === "COMMIT") {
        if (!working) throw new Error("COMMIT without transaction");
        committed = working;
        working = null;
        return { rows: [] };
      }
      if (statement === "ROLLBACK") {
        if (!working) throw new Error("ROLLBACK without transaction");
        working = null;
        return { rows: [] };
      }
      if (/INSERT\s+INTO\s+ingestion\.raw_wait_observations/i.test(statement)) {
        rawInsertAttempts += 1;
        throw new Error("raw observation writes are forbidden in replay tests");
      }
      if (!working) throw new Error("write repository called outside transaction");
      if (statement.includes("pg_advisory_xact_lock")) return { rows: [] };

      if (statement.includes("FROM ingestion.raw_archive_line_references")) {
        const row = working.references.get(params[0]);
        return { rows: row ? [structuredClone(row)] : [] };
      }
      if (statement.includes("INSERT INTO ingestion.raw_archive_line_references")) {
        const row = Object.fromEntries(REFERENCE_FIELDS.map((field, index) => [field, params[index]]));
        working.references.set(row.raw_observation_id, row);
        return { rows: [] };
      }
      if (statement.includes("same_semantic_payload") && statement.includes("FROM observations.normalized_wait_observations_v2")) {
        const row = working.normalized.get(params[0]);
        if (!row) return { rows: [] };
        const same = SEMANTIC_FIELDS.every((field, index) =>
          JSON.stringify(row[field]) === JSON.stringify(params[index + 1])
        );
        return { rows: [{ same_semantic_payload: same, generated_at: row.generated_at }] };
      }
      if (statement.includes("INSERT INTO observations.normalized_wait_observations_v2")) {
        if (failNormalizedInsert) throw Object.assign(new Error("synthetic normalized insert failure"), { code: "FAKE_NORMALIZED_INSERT_FAILED" });
        const row = Object.fromEntries(NORMALIZED_FIELDS.map((field, index) => [field, params[index]]));
        if (!working.references.has(row.raw_observation_id)) throw Object.assign(new Error("missing archive line FK"), { code: "23503" });
        working.normalized.set(row.normalized_observation_id, row);
        return { rows: [{ generated_at: row.generated_at }] };
      }
      if (statement.includes("FROM catalog.catalog_entry_snapshots")) {
        const key = [params[0], params[1], params[2], params[3]].join("\u0000");
        const row = working.catalogEntries.get(key);
        return { rows: row ? [{ catalog_entry_id: row.catalog_entry_id, entry_document: row.entry_document }] : [] };
      }
      if (statement.includes("INSERT INTO catalog.catalog_entry_snapshots")) {
        const row = {
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
        const key = [row.park_id, row.canonical_attraction_id, row.catalog_version, row.valid_from].join("\u0000");
        working.catalogEntries.set(key, row);
        return { rows: [{ catalog_entry_id: row.catalog_entry_id }] };
      }
      if (statement.includes("INSERT INTO ingestion.source_health")) {
        const row = Object.fromEntries(HEALTH_FIELDS.map((field, index) => [field, params[index]]));
        working.sourceHealth.set(`${row.source_name}\u0000${row.run_id}`, row);
        return { rows: [] };
      }
      throw new Error(`Unexpected replay fake SQL: ${statement}`);
    },
    release() {}
  };
  const pool = { async connect() { return client; } };
  const readOnlyQuery = {
    async query(sql) {
      readOnlyCountCalls += 1;
      assert.match(sql, /SELECT count\(\*\).*FROM ingestion\.raw_wait_observations/i);
      return { rows: [{ count: committed.rawObservationCount }] };
    }
  };
  return {
    database: createPostgresR2ReplayDatabase({
      transactionPool: pool,
      readOnlyQuery,
      targetLabel: "neon-validation-branch-only"
    }),
    queries,
    get committed() { return committed; },
    get transactionCount() { return transactionCount; },
    get readOnlyCountCalls() { return readOnlyCountCalls; },
    get rawInsertAttempts() { return rawInsertAttempts; }
  };
}

function makeMultiFakeR2(fixtures) {
  const byUri = new Map(fixtures.map((fixture) => [fixture.archive.object_uri, fixture]));
  const calls = [];
  return {
    calls,
    async getObject(uri) {
      calls.push(uri);
      const fixture = byUri.get(uri);
      if (!fixture) throw new Error(`unexpected replay fixture URI: ${uri}`);
      return {
        r2_uri: uri,
        immutable: true,
        body: fixture.content,
        contentLength: fixture.content.byteLength,
        metadata: {
          sha256: fixture.archive.sha256,
          schema_version: fixture.archive.schema_version
        }
      };
    }
  };
}

function assertSchemaConformance(value, schema, rootSchema, location = "$") {
  if (rootSchema === undefined) rootSchema = schema;
  schema = resolveSchemaReference(schema, rootSchema);
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((branch) => {
      try {
        assertSchemaConformance(value, branch, rootSchema, location);
        return true;
      } catch {
        return false;
      }
    });
    assert.equal(matches.length, 1, `${location} must match exactly one schema variant`);
    return;
  }
  if (schema.const !== undefined) assert.deepEqual(value, schema.const, `${location} must match const`);
  if (schema.enum) assert.ok(schema.enum.includes(value), `${location} must match enum`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    assert.ok(types.some((type) => matchesSchemaType(value, type)), `${location} has an invalid type`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined) assert.ok(value.length >= schema.minLength, `${location} is too short`);
    if (schema.pattern) assert.match(value, new RegExp(schema.pattern), `${location} does not match its pattern`);
    if (schema.format === "date-time") assert.ok(!Number.isNaN(Date.parse(value)), `${location} is not a date-time`);
  }
  if (typeof value === "number" && schema.minimum !== undefined) {
    assert.ok(value >= schema.minimum, `${location} is below its minimum`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => assertSchemaConformance(item, schema.items, rootSchema, `${location}[${index}]`));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const required of schema.required || []) {
      assert.ok(Object.hasOwn(value, required), `${location}.${required} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        assert.ok(schema.properties?.[key], `${location}.${key} is not allowed`);
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, key)) assertSchemaConformance(value[key], childSchema, rootSchema, `${location}.${key}`);
    }
  }
}

function resolveSchemaReference(schema, rootSchema) {
  if (!schema?.$ref) return schema;
  let current = rootSchema;
  for (const part of schema.$ref.replace(/^#\//, "").split("/")) {
    current = current?.[part];
  }
  assert.ok(current, `unresolvable schema reference ${schema.$ref}`);
  return current;
}

function matchesSchemaType(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}
