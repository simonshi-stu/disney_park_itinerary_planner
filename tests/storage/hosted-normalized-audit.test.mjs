import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildOfflineAuditReport,
  createPostgresReadOnlyAuditReader,
  createProductionAuditReaders,
  maximumAuditBatchSize,
  resolveAuditBatchSize,
  runAuditCli,
  runHostedNormalizedAudit
} from "../../scripts/audit-hosted-normalized-persistence.mjs";
import { calculateRawObservationId } from "../../infra/archive-line-reference-postgres.mjs";
import { parseCsv, rawSchemaVersion } from "../../infra/backfill/wait-time-records.mjs";
import { r2ReplayTransformationVersion } from "../../infra/backfill/r2-normalized-records.mjs";
import { calculateNormalizedObservationId } from "../../infra/normalized-observations-postgres.mjs";
import {
  calculateDatabaseFingerprint,
  normalizedOnlyTransformationVersion
} from "../../infra/normalized-only-hosted-write.mjs";
import { normalizeArchivedWaitObservation } from "../../modules/observations/index.mjs";

const checkedAt = "2026-10-01T00:00:00.000Z";
const databaseUrl = "postgres://user:secret@validation.example:5432/neon";
const targetFingerprint = calculateDatabaseFingerprint(databaseUrl);
const bucket = "synthetic-validation-bucket";
const liveSourceName = "queue-times-bootstrap";
const historyTransformationVersion = r2ReplayTransformationVersion;
const liveTransformationVersion = normalizedOnlyTransformationVersion;
const requiredRelations = [
  "ingestion.raw_archives",
  "ingestion.raw_wait_observations",
  "ingestion.raw_archive_line_references",
  "observations.normalized_wait_observations_v2",
  "catalog.catalog_entry_snapshots",
  "ingestion.source_health"
];

test("CLI --check emits a schema-valid blocked report without opening readers", async () => {
  const schema = await loadSchema();
  let stdout = "";
  let stderr = "";
  const exitCode = await runAuditCli(["--check"], {
    writeStdout: (text) => { stdout += text; },
    writeStderr: (text) => { stderr += text; }
  }, { environment: {} });

  assert.equal(exitCode, 0);
  assert.equal(stderr, "");
  const report = JSON.parse(stdout);
  assert.equal(report.contract_version, "hosted-normalized-audit-report.v1");
  assert.equal(report.status, "blocked");
  assert.equal(report.read_only, true);
  assert.equal(report.mode, "offline-check");
  assert.equal(report.connections_opened, false);
  assert.equal(report.complete, false);
  assert.ok(report.blockers.includes("prior_validation_branch_expired_2026-09-30"));
  assert.ok(report.blockers.includes("read_only_validation_authorization_not_supplied"));
  assert.ok(report.blockers.includes("live_git_archive_evidence_not_supplied"));
  assert.deepEqual(report.versions.audited_transformation_versions, []);
  assertSchemaConformance(report, schema);
});

test("CLI rejects ambiguous, repeated or malformed mode/date flags before readers", async () => {
  const cases = [
    [],
    ["--check", "--live"],
    ["--check", "--check"],
    ["--live", "--live"],
    ["--date=2026-10-01"],
    ["--live", "--date=2026-10-01"],
    ["--live", "--date=2026-13-40"],
    ["--live", "--date=2026-02-30"],
    ["--live", "--date=20261001"],
    ["--live", "--date=2026-10-01", "--date=2026-10-02"],
    ["--live", "--unknown"]
  ];
  for (const args of cases) {
    let factoryCalls = 0;
    let stderr = "";
    const exitCode = await runAuditCli(args, {
      writeStdout: () => {},
      writeStderr: (text) => { stderr += text; }
    }, {
      environment: {},
      readersFactory: async () => {
        factoryCalls += 1;
        throw new Error("readers must not be created for a rejected CLI invocation");
      }
    });
    assert.equal(exitCode, 2, args.join(" "));
    assert.match(stderr, /Usage:/, args.join(" "));
    assert.equal(factoryCalls, 0, args.join(" "));
  }
});

test("unreadable live input is surfaced as a redacted blocker", async () => {
  let stdout = "";
  const exitCode = await runAuditCli(["--live"], {
    writeStdout: (text) => { stdout += text; },
    writeStderr: () => {}
  }, {
    environment: { HOSTED_AUDIT_RUNS_PATH: path.join(path.sep, "definitely-missing-04d6", "runs.json") },
    readersFactory: async () => { throw new Error("readers must not be created for a blocked audit"); }
  });

  assert.equal(exitCode, 1);
  const report = JSON.parse(stdout);
  assert.equal(report.status, "blocked");
  assert.equal(report.connections_opened, false);
  assert.ok(report.blockers.some((blocker) => blocker.startsWith("live_audit_inputs_unreadable:")));
  assertSchemaConformance(report, await loadSchema());
});

test("production read-only wrapper preserves primary errors and destroys dirty clients", async () => {
  const original = Object.assign(new Error("operation failed"), { code: "OP_FAILED" });

  // (a) operation fails + rollback succeeds => original error, normal release
  {
    const fake = createFakePool();
    const reader = await createPostgresReadOnlyAuditReader({ databaseUrl, poolFactory: async () => fake.pool });
    const caught = await captureRejection(() => reader.withReadOnlyTransaction(async () => { throw original; }));
    assert.equal(caught, original);
    assert.deepEqual(fake.events, ["BEGIN TRANSACTION READ ONLY", "ROLLBACK"]);
    assert.deepEqual(fake.releases, [null]);
  }

  // (b) operation fails + rollback fails => original stays primary, release receives error
  {
    const fake = createFakePool({ failRollback: true });
    const reader = await createPostgresReadOnlyAuditReader({ databaseUrl, poolFactory: async () => fake.pool });
    const caught = await captureRejection(() => reader.withReadOnlyTransaction(async () => { throw original; }));
    assert.equal(caught, original);
    assert.equal(caught.rollbackError, fake.rollbackError);
    assert.equal(fake.rollbackCalls, 1, "an operation failure attempts exactly one rollback");
    assert.equal(fake.releases.length, 1);
    assert.equal(fake.releases[0], fake.rollbackError);
  }

  // (c) BEGIN fails => release receives error and the operation is never called
  {
    const beginError = Object.assign(new Error("begin failed"), { code: "BEGIN_FAILED" });
    const fake = createFakePool({ beginError });
    const reader = await createPostgresReadOnlyAuditReader({ databaseUrl, poolFactory: async () => fake.pool });
    let operationCalls = 0;
    const caught = await captureRejection(() => reader.withReadOnlyTransaction(async () => { operationCalls += 1; }));
    assert.equal(caught, beginError);
    assert.equal(operationCalls, 0);
    assert.equal(fake.releases[0], beginError);
  }

  // (d) success => rollback then normal release
  {
    const fake = createFakePool();
    const reader = await createPostgresReadOnlyAuditReader({ databaseUrl, poolFactory: async () => fake.pool });
    const result = await reader.withReadOnlyTransaction(async ({ query }) => {
      await query("SELECT 1");
      return "ok";
    });
    assert.equal(result, "ok");
    assert.deepEqual(fake.events, ["BEGIN TRANSACTION READ ONLY", "SELECT 1", "ROLLBACK"]);
    assert.deepEqual(fake.releases, [null]);
  }

  // (e) success but terminal rollback fails => no retry, release(error)/destroy
  {
    const fake = createFakePool({ failFirstRollbackOnly: true });
    const reader = await createPostgresReadOnlyAuditReader({ databaseUrl, poolFactory: async () => fake.pool });
    const caught = await captureRejection(() => reader.withReadOnlyTransaction(async ({ query }) => {
      await query("SELECT 1");
      return "ok";
    }));
    assert.equal(caught, fake.rollbackError);
    assert.equal(fake.rollbackCalls, 1, "the terminal ROLLBACK must never be retried");
    assert.equal(fake.releases.length, 1);
    assert.equal(fake.releases[0], fake.rollbackError);
  }
});

test("production readers use only an explicitly injected pool factory", async () => {
  const fake = createFakePool();
  let factoryCalls = 0;
  const readers = await createProductionAuditReaders({
    environment: {
      RAW_ARCHIVE_BUCKET: "synthetic-bucket",
      HOSTED_AUDIT_POOL_FACTORY: "not-a-factory-environment-string"
    },
    databaseUrl,
    poolFactory: async (url) => {
      factoryCalls += 1;
      assert.equal(url, databaseUrl);
      return fake.pool;
    }
  });
  try {
    const result = await readers.database.withReadOnlyTransaction(async ({ query }) => {
      await query("SELECT 1");
      return "ok";
    });
    assert.equal(result, "ok");
    assert.equal(factoryCalls, 1);
  } finally {
    await readers.database.close();
    await readers.r2.close();
  }
});

test("audit batch size is capped to a safe finite maximum", () => {
  assert.equal(resolveAuditBatchSize(undefined), 200);
  assert.equal(resolveAuditBatchSize(50), 50);
  assert.equal(resolveAuditBatchSize(10_000), maximumAuditBatchSize);
  assert.equal(maximumAuditBatchSize, 500);
});

test("missing or expired target authorization blocks before any reader is created", async () => {
  let factoryCalls = 0;
  const report = await runHostedNormalizedAudit(auditInputs({
    authorization: readOnlyAuthorization({ expiresAt: "2026-09-30T00:00:00.000Z" }),
    readersFactory: async () => {
      factoryCalls += 1;
      throw new Error("readers must not be created for a blocked audit");
    }
  }));

  assert.equal(report.status, "blocked");
  assert.equal(report.connections_opened, false);
  assert.ok(report.blockers.some((blocker) => blocker.startsWith("authorization_rejected:")));
  assert.ok(report.blockers.some((blocker) => blocker.includes("authorization_expired")));
  assert.equal(factoryCalls, 0, "blocked audits must not request live readers");
});

test("production labels and URL routing overrides are rejected before any connection", async () => {
  const report = await runHostedNormalizedAudit(auditInputs({
    targetName: "production-neon-branch",
    databaseUrl: `${databaseUrl}?host=evil.example`,
    targetFingerprint,
    readersFactory: async () => {
      throw new Error("readers must not be created");
    }
  }));

  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("validation_target_name_must_not_be_production"));
  assert.ok(report.blockers.some((blocker) => blocker.startsWith("target_fingerprint_rejected:") && blocker.includes("routing override")));
});

test("invalid audit run_id and non-UTC checked_at block a live audit", async () => {
  const invalidRunId = await runHostedNormalizedAudit(auditInputs({
    runId: "   ",
    readersFactory: async () => { throw new Error("readers must not be created"); }
  }));
  assert.equal(invalidRunId.status, "blocked");
  assert.ok(invalidRunId.blockers.includes("audit_run_id_required"));
  assert.ok(invalidRunId.run_id.length > 0, "the report must still carry a usable run id");

  for (const value of ["2026-10-01T00:00:00+02:00", "2026-02-30T00:00:00Z", "not-a-date"]) {
    const report = await runHostedNormalizedAudit(auditInputs({
      checkedAt: value,
      readersFactory: async () => { throw new Error("readers must not be created"); }
    }));
    assert.equal(report.status, "blocked", value);
    assert.ok(report.blockers.includes("checked_at_must_be_strict_utc"), value);
    assert.match(report.checked_at, /Z$/);
  }
});

test("missing history or live archive evidence blocks before readers", async () => {
  const data = fixture();

  const noLive = await runHostedNormalizedAudit(auditInputs({
    git: { historyArchives: [data.history.archive], liveArchives: [], runs: [data.live.run] },
    readersFactory: async () => { throw new Error("readers must not be created"); }
  }));
  assert.equal(noLive.status, "blocked");
  assert.ok(noLive.blockers.includes("git_live_archive_evidence_missing"));
  assert.equal(noLive.connections_opened, false);

  const noHistory = await runHostedNormalizedAudit(auditInputs({
    git: { historyArchives: [], liveArchives: [data.live.archive], runs: [data.live.run] },
    readersFactory: async () => { throw new Error("readers must not be created"); }
  }));
  assert.equal(noHistory.status, "blocked");
  assert.ok(noHistory.blockers.includes("git_history_archive_evidence_missing"));

  const noRuns = await runHostedNormalizedAudit(auditInputs({
    git: { historyArchives: [data.history.archive], liveArchives: [data.live.archive], runs: [] },
    readersFactory: async () => { throw new Error("readers must not be created"); }
  }));
  assert.equal(noRuns.status, "blocked");
  assert.ok(noRuns.blockers.includes("git_run_evidence_missing"));
});

test("run-to-archive linkage and duplicate run evidence are validated", async () => {
  const data = fixture();

  const unlinkedRun = await runHostedNormalizedAudit(auditInputs({
    git: {
      historyArchives: [data.history.archive],
      liveArchives: [data.live.archive],
      runs: [{ ...data.live.run, payload_sha256: "a".repeat(64) }]
    },
    readersFactory: async () => { throw new Error("readers must not be created"); }
  }));
  assert.equal(unlinkedRun.status, "blocked");
  assert.ok(unlinkedRun.blockers.includes("live_run_archive_evidence_missing"));
  assert.ok(unlinkedRun.blockers.includes("live_archive_run_link_conflict"));

  const conflictingRuns = await runHostedNormalizedAudit(auditInputs({
    git: {
      historyArchives: [data.history.archive],
      liveArchives: [data.live.archive],
      runs: [data.live.run, { ...data.live.run, record_count: data.live.rows.length + 1 }]
    },
    readersFactory: async () => { throw new Error("readers must not be created"); }
  }));
  assert.equal(conflictingRuns.status, "blocked");
  assert.ok(conflictingRuns.blockers.includes("duplicate_git_run_evidence"));

  const missingSource = await runHostedNormalizedAudit(auditInputs({
    git: {
      historyArchives: [data.history.archive],
      liveArchives: [data.live.archive],
      runs: [{ ...data.live.run, source_name: undefined }]
    },
    readersFactory: async () => { throw new Error("readers must not be created"); }
  }));
  assert.equal(missingSource.status, "blocked");
  assert.ok(missingSource.blockers.includes("git_run_source_name_required"));
});

test("combined archive evidence is accepted with explicit transformation versions", async () => {
  const data = fixture();
  const fake = createFakeDatabaseReader({ state: seededState({ data }) });
  const r2 = createFakeR2Reader({ fixtures: [data.history, data.live] });
  const report = await runHostedNormalizedAudit(auditInputs({
    data,
    git: {
      archives: [data.history.archive, data.live.archive],
      runs: [data.live.run]
    },
    readers: { database: fake.reader, r2 }
  }));

  assert.equal(report.status, "passed");
  assert.equal(report.counts.git_history_archives, 1);
  assert.equal(report.counts.git_live_archives, 1);
  assert.deepEqual(report.versions.transformation_versions, [liveTransformationVersion, historyTransformationVersion].sort());

  const missingVersion = await runHostedNormalizedAudit(auditInputs({
    data,
    git: {
      historyArchives: [data.history.archive],
      liveArchives: [{ ...data.live.archive, transformation_version: undefined }],
      runs: [data.live.run]
    },
    readersFactory: async () => { throw new Error("readers must not be created"); }
  }));
  assert.equal(missingVersion.status, "blocked");
  assert.ok(missingVersion.blockers.includes("git_archive_transformation_version_invalid"));

  const mismatchedVersion = await runHostedNormalizedAudit(auditInputs({
    data,
    git: {
      historyArchives: [],
      liveArchives: [data.history.archive],
      runs: [data.live.run]
    },
    readersFactory: async () => { throw new Error("readers must not be created"); }
  }));
  assert.equal(mismatchedVersion.status, "blocked");
  assert.ok(mismatchedVersion.blockers.includes("git_archive_transformation_version_mismatch"));
});

test("retry evidence is explicit and validated", async () => {
  const data = fixture();
  const retryRun = { ...data.live.run, run_id: "run-live-1-retry", retry_of: data.live.run.run_id };
  const state = seededState({ data });
  state.sourceHealth.push(sourceHealthFor(data.live, { run_id: "run-live-1-retry" }));
  const report = await runHostedNormalizedAudit(auditInputs({
    data,
    git: {
      historyArchives: [data.history.archive],
      liveArchives: [data.live.archive],
      runs: [data.live.run, retryRun]
    },
    readers: {
      database: createFakeDatabaseReader({ state }).reader,
      r2: createFakeR2Reader({ fixtures: [data.history, data.live] })
    }
  }));
  assert.equal(report.status, "passed");
  assert.equal(report.source_health.expected_runs, 2);
  assert.equal(report.source_health.matched_runs, 2);
  assert.equal(report.source_health.retried_runs, 1);
  assert.equal(report.source_health.duplicate_runs, 0);

  const invalidRetry = await runHostedNormalizedAudit(auditInputs({
    data,
    git: {
      historyArchives: [data.history.archive],
      liveArchives: [data.live.archive],
      runs: [data.live.run, { ...retryRun, retry_of: "run-does-not-exist" }]
    },
    readersFactory: async () => { throw new Error("readers must not be created"); }
  }));
  assert.equal(invalidRetry.status, "blocked");
  assert.ok(invalidRetry.blockers.includes("live_run_retry_evidence_invalid"));
});

test("capacity thresholds block before readers and above-threshold never passes", async () => {
  const cases = [
    { capacity: capacityEvidence({ usedBytes: 900_000 }), code: "capacity_stop_threshold_reached", within: false },
    { capacity: capacityEvidence({ usedBytes: 1_000_001 }), code: "capacity_exceeds_max_capacity", within: false },
    { capacity: capacityEvidence({ stopThresholdBytes: 980_000 }), code: "capacity_headroom_violated", within: true },
    { capacity: capacityEvidence({ measuredAt: "2026-09-28T00:00:00.000Z" }), code: "capacity_measurement_stale" },
    { capacity: capacityEvidence({ measuredAt: "2026-10-02T00:00:00.000Z" }), code: "capacity_measurement_future" },
    { capacity: capacityEvidence({ targetFingerprint: "b".repeat(64) }), code: "capacity_target_fingerprint_mismatch" }
  ];
  for (const testCase of cases) {
    let factoryCalls = 0;
    const report = await runHostedNormalizedAudit(auditInputs({
      capacity: testCase.capacity,
      readersFactory: async () => {
        factoryCalls += 1;
        throw new Error("readers must not be created");
      }
    }));
    assert.equal(report.status, "blocked", testCase.code);
    assert.ok(report.blockers.includes(testCase.code), testCase.code);
    assert.equal(factoryCalls, 0, testCase.code);
    if (testCase.within !== undefined) {
      assert.equal(report.capacity.within_threshold, testCase.within, testCase.code);
      assert.equal(typeof report.capacity.remaining_to_stop_bytes, "number", testCase.code);
    }
  }

  const atThreshold = await runHostedNormalizedAudit(auditInputs({
    capacity: capacityEvidence({ usedBytes: 900_000, stopThresholdBytes: 900_000 })
  }));
  assert.equal(atThreshold.status, "blocked");
  assert.equal(atThreshold.capacity.within_threshold, false);
  assert.equal(atThreshold.capacity.remaining_to_stop_bytes, 0);
  assert.equal(atThreshold.complete, false);
});

test("reviewed inputs reject alias ambiguity and duplicate access-mode mappings", async () => {
  const data = fixture();
  const ambiguousCatalog = catalogSnapshot();
  const duplicate = structuredClone(ambiguousCatalog.entries[0]);
  duplicate.canonical_attraction_id = "dca-fixture-ride-other";
  duplicate.canonical_attraction_name = "Fixture Ride Other";
  duplicate.lifecycle.canonical_attraction_id = "dca-fixture-ride-other";
  ambiguousCatalog.entries.push(duplicate);

  const ambiguous = await runHostedNormalizedAudit(auditInputs({
    data,
    catalogSnapshot: ambiguousCatalog,
    accessModeMapping: accessModeMapping({ catalogVersion: ambiguousCatalog.catalog_version }),
    readersFactory: async () => { throw new Error("readers must not be created"); }
  }));
  assert.equal(ambiguous.status, "blocked");
  assert.ok(ambiguous.blockers.includes("reviewed_catalog_snapshot_cross_entry_alias_ambiguity"));

  const mapping = accessModeMapping();
  mapping.mappings.push({ park_id: "dca", ride_id: "ride-1", access_mode: "single_rider" });
  const duplicated = await runHostedNormalizedAudit(auditInputs({
    data,
    accessModeMapping: mapping,
    readersFactory: async () => { throw new Error("readers must not be created"); }
  }));
  assert.equal(duplicated.status, "blocked");
  assert.ok(duplicated.blockers.includes("duplicate_access_mode_mapping_2"));
});

test("passing history+live audit uses only read-only SQL, rolls back, and closes readers", async () => {
  const schema = await loadSchema();
  const data = fixture();
  const fake = createFakeDatabaseReader({ state: seededState({ data }) });
  const r2 = createFakeR2Reader({ fixtures: [data.history, data.live] });
  const report = await runHostedNormalizedAudit(auditInputs({
    data,
    mode: "offline-check",
    git: {
      historyArchives: [data.history.archive],
      liveArchives: [data.live.archive],
      runs: [data.live.run]
    },
    readers: { database: fake.reader, r2 }
  }));

  assert.equal(report.status, "passed");
  assert.equal(report.mode, "live-read-only", "the live runner must never honor an offline mode override");
  assert.equal(report.complete, true);
  assert.equal(report.connections_opened, true);
  assert.equal(report.inventory.status, "complete");
  assert.equal(report.counts.git_archives, 2);
  assert.equal(report.counts.git_history_archives, 1);
  assert.equal(report.counts.git_live_archives, 1);
  assert.equal(report.counts.git_runs, 1);
  assert.equal(report.counts.r2_objects_verified, 2);
  assert.equal(report.counts.raw_rows_processed, data.history.rows.length + data.live.rows.length);
  assert.equal(report.counts.normalized_expected, data.history.rows.length + data.live.rows.length);
  assert.equal(report.counts.normalized_found, data.history.rows.length + data.live.rows.length);
  assert.equal(report.counts.normalized_missing, 0);
  assert.equal(report.counts.normalized_semantic_mismatches, 0);
  assert.equal(report.counts.archive_line_references_found, data.history.rows.length + data.live.rows.length);
  assert.equal(report.counts.db_raw_observations, 440);
  assert.equal(report.source_health.matched_runs, 1);
  assert.equal(report.source_health.duplicate_runs, 0);
  assert.equal(report.source_health.retried_runs, 0);
  assert.equal(report.raw_baseline.unchanged, true);
  assert.equal(report.raw_baseline.new_raw_rows, 0);
  assert.equal(report.capacity.fresh, true);
  assert.equal(report.capacity.within_threshold, true);
  assert.deepEqual(report.versions.transformation_versions, [liveTransformationVersion, historyTransformationVersion].sort());
  assert.deepEqual(report.versions.audited_transformation_versions, [liveTransformationVersion, historyTransformationVersion].sort());

  assert.ok(fake.sessions.length >= 3, "context, per-archive and final count sessions");
  for (const session of fake.sessions) {
    assert.equal(session.statements[0], "BEGIN TRANSACTION READ ONLY");
    assert.equal(session.statements.at(-1), "ROLLBACK");
    assert.equal(session.statements.some((sql) => sql === "COMMIT"), false);
  }
  assert.equal(fake.writes.length, 0, "the audit must never issue a write statement");
  assert.equal(fake.closed, 1);
  assert.equal(r2.calls.filter(({ type }) => type === "put" || type === "delete").length, 0);
  assert.equal(r2.calls.at(-1).type, "close");
  assertSchemaConformance(report, schema);
});

test("query failure rolls back, releases and closes without hiding the failure", async () => {
  const data = fixture();
  const fake = createFakeDatabaseReader({
    state: seededState({ data }),
    failOn: /count\(\*\)::bigint FROM ingestion\.raw_archives/
  });
  const r2 = createFakeR2Reader({ fixtures: [data.history, data.live] });
  const report = await runHostedNormalizedAudit(auditInputs({
    data,
    git: {
      historyArchives: [data.history.archive],
      liveArchives: [data.live.archive],
      runs: [data.live.run]
    },
    readers: { database: fake.reader, r2 }
  }));

  assert.equal(report.status, "failed");
  assert.ok(report.failures.some((failure) => failure.category === "audit_execution_failed"));
  assert.equal(fake.sessions.length, 1);
  assert.equal(fake.sessions[0].statements[0], "BEGIN TRANSACTION READ ONLY");
  assert.equal(fake.sessions[0].statements.at(-1), "ROLLBACK");
  assert.equal(fake.writes.length, 0);
  assert.equal(fake.closed, 1);
  assert.equal(r2.calls.filter(({ type }) => type === "put" || type === "delete").length, 0);
});

test("missing required relations are reported before count queries", async () => {
  const data = fixture();
  const missingRelation = "observations.normalized_wait_observations_v2";
  const fake = createFakeDatabaseReader({
    state: seededState({
      data,
      presentRelations: new Set(requiredRelations.filter((relation) => relation !== missingRelation))
    })
  });
  const r2 = createFakeR2Reader({ fixtures: [data.history, data.live] });
  const report = await runHostedNormalizedAudit(auditInputs({
    data,
    git: { historyArchives: [data.history.archive], liveArchives: [data.live.archive], runs: [data.live.run] },
    readers: { database: fake.reader, r2 }
  }));

  assert.equal(report.status, "failed");
  const schemaFailure = report.failures.find((failure) => failure.category === "schema_relation_missing");
  assert.ok(schemaFailure);
  assert.deepEqual(schemaFailure.samples[0], { relation: missingRelation });
  assert.equal(report.failures.some((failure) => failure.category === "audit_execution_failed"), false);
  const countQueries = fake.sessions
    .flatMap((session) => session.statements)
    .filter((sql) => sql.includes("count(*)::bigint"));
  assert.equal(countQueries.length, 0, "schema presence must be observable before count queries");
});

test("R2 content, metadata, schema and byte-size mismatches fail closed", async () => {
  const schema = await loadSchema();
  const cases = [
    { name: "content", override: { content: Buffer.from("tampered") }, category: "r2_content_sha_mismatch" },
    { name: "metadata sha", override: { metadataSha256: "f".repeat(64) }, category: "r2_metadata_sha_mismatch" },
    { name: "metadata schema", override: { metadataSchemaVersion: "other.v1" }, category: "r2_metadata_schema_mismatch" },
    { name: "byte size", override: { headByteSize: 1 }, category: "r2_byte_size_mismatch" }
  ];
  for (const testCase of cases) {
    const data = fixture();
    const fake = createFakeDatabaseReader({ state: seededState({ data }) });
    const r2 = createFakeR2Reader({ fixtures: [data.history, data.live], overrides: testCase.override });
    const report = await runHostedNormalizedAudit(auditInputs({
      data,
      git: { historyArchives: [data.history.archive], liveArchives: [data.live.archive], runs: [data.live.run] },
      readers: { database: fake.reader, r2 }
    }));

    assert.equal(report.status, "failed", testCase.name);
    assert.ok(report.failures.some((failure) => failure.category === testCase.category), testCase.name);
    assert.equal(report.counts.r2_objects_verified, 0, testCase.name);
    assertSchemaConformance(report, schema);
  }
});

test("listed size parity is an explicit early mismatch while head/body stay authoritative", async () => {
  const data = fixture();
  const fake = createFakeDatabaseReader({ state: seededState({ data }) });
  const r2 = createFakeR2Reader({ fixtures: [data.history, data.live], overrides: { listSize: 123 } });
  const report = await runHostedNormalizedAudit(auditInputs({
    data,
    git: { historyArchives: [data.history.archive], liveArchives: [data.live.archive], runs: [data.live.run] },
    readers: { database: fake.reader, r2 }
  }));

  assert.equal(report.status, "failed");
  const mismatch = report.failures.find((failure) => failure.category === "r2_list_size_mismatch");
  assert.equal(mismatch.count, 2);
  assert.equal(mismatch.samples[0].listed, 123);
  assert.equal(report.counts.r2_objects_verified, 2, "head/body verification remains authoritative");
});

test("matched inventory entries require a nonempty bucket and omitted live objects fail", async () => {
  const data = fixture();
  const badBucketList = [
    { key: data.history.key, bucket, size: data.history.archive.byte_size },
    { key: data.live.key, bucket: "", size: data.live.archive.byte_size }
  ];
  const badBucket = await runHostedNormalizedAudit(auditInputs({
    data,
    git: { historyArchives: [data.history.archive], liveArchives: [data.live.archive], runs: [data.live.run] },
    readers: {
      database: createFakeDatabaseReader({ state: seededState({ data }) }).reader,
      r2: createFakeR2Reader({ fixtures: [data.history, data.live], overrides: { listed: badBucketList } })
    }
  }));
  assert.equal(badBucket.status, "failed");
  assert.equal(badBucket.inventory.status, "incomplete");
  assert.ok(badBucket.failures.some((failure) => failure.category === "r2_inventory_entry_invalid"));

  const missingLiveObjects = await runHostedNormalizedAudit(auditInputs({
    data,
    git: { historyArchives: [data.history.archive], liveArchives: [data.live.archive], runs: [data.live.run] },
    readers: {
      database: createFakeDatabaseReader({ state: seededState({ data }) }).reader,
      r2: createFakeR2Reader({ fixtures: [data.history] })
    }
  }));
  assert.equal(missingLiveObjects.status, "failed");
  assert.ok(missingLiveObjects.failures.some((failure) => failure.category === "r2_object_missing"));
});

test("missing R2 object and unexpected inventory objects are counted with bounded samples", async () => {
  const data = fixture();
  const fake = createFakeDatabaseReader({ state: seededState({ data }) });
  const extras = Array.from({ length: 25 }, (_, index) => `wait-times/${"e".repeat(64)}/extra-${index}.csv`);
  const r2 = createFakeR2Reader({ fixtures: [data.history], extraListed: extras });
  const report = await runHostedNormalizedAudit(auditInputs({
    data,
    git: { historyArchives: [data.history.archive], liveArchives: [data.live.archive], runs: [data.live.run] },
    readers: { database: fake.reader, r2 },
    diagnosticSampleLimit: 7
  }));

  assert.equal(report.status, "failed");
  assert.equal(report.inventory.status, "incomplete");
  assert.equal(report.inventory.missing, 1);
  assert.equal(report.inventory.extra, 25);
  assert.equal(report.inventory.samples.length, 7, "inventory samples honor diagnosticSampleLimit");
  const extraFailure = report.failures.find((failure) => failure.category === "r2_extra_object");
  assert.equal(extraFailure.count, 25, "complete count despite bounded samples");
  assert.equal(extraFailure.included_count, 7);
  assert.equal(extraFailure.omitted_count, 18);
  assert.equal(extraFailure.samples.length, 7);
  assert.ok(report.failures.some((failure) => failure.category === "r2_object_missing"));
});

test("two-version normalized keys never mask each other across archives", async () => {
  const schema = await loadSchema();
  const data = fixture();
  const rawHistoryId = calculateRawObservationId(data.history.archive.sha256, 1);
  const liveKeyForHistoryRow = calculateNormalizedObservationId(rawHistoryId, liveTransformationVersion);

  const state = seededState({ data });
  // Seed an extra live-version row for a history raw observation: a raw-id fold
  // would silently match it, an exact primary-key lookup must not.
  state.normalized.push({
    ...expectedRecords(data.live)[0].normalizedObservation,
    raw_observation_id: rawHistoryId,
    normalized_observation_id: liveKeyForHistoryRow,
    generated_at: checkedAt
  });
  const fake = createFakeDatabaseReader({ state });
  const report = await runHostedNormalizedAudit(auditInputs({
    data,
    git: { historyArchives: [data.history.archive], liveArchives: [data.live.archive], runs: [data.live.run] },
    readers: { database: fake.reader, r2: createFakeR2Reader({ fixtures: [data.history, data.live] }) }
  }));

  assert.equal(report.status, "passed", "the extra other-version row must not affect the audit");
  assert.equal(report.counts.normalized_found, data.history.rows.length + data.live.rows.length);
  assert.deepEqual(report.versions.audited_transformation_versions, [liveTransformationVersion, historyTransformationVersion].sort());
  assert.ok(fake.sessions.every((session) =>
    session.statements.every((sql) => {
      const whereClause = sql.split(/WHERE/i)[1] || "";
      return !(sql.includes("normalized_wait_observations_v2") && whereClause.includes("raw_observation_id"));
    })));
  assertSchemaConformance(report, schema);

  // Masking regression: the history-version row is absent and only the live-version
  // row exists for that raw observation. The audit must fail closed.
  const maskedState = seededState({ data, omitNormalized: [`${data.history.archive.sha256}:1`] });
  maskedState.normalized.push({
    ...expectedRecords(data.live)[0].normalizedObservation,
    raw_observation_id: rawHistoryId,
    normalized_observation_id: liveKeyForHistoryRow,
    generated_at: checkedAt
  });
  const masked = await runHostedNormalizedAudit(auditInputs({
    data,
    git: { historyArchives: [data.history.archive], liveArchives: [data.live.archive], runs: [data.live.run] },
    readers: {
      database: createFakeDatabaseReader({ state: maskedState }).reader,
      r2: createFakeR2Reader({ fixtures: [data.history, data.live] })
    }
  }));
  assert.equal(masked.status, "failed");
  assert.equal(masked.counts.normalized_found, data.history.rows.length + data.live.rows.length - 1);
  assert.equal(masked.counts.normalized_missing, 1);
  const missing = masked.failures.find((failure) => failure.category === "normalized_observation_missing");
  assert.equal(missing.samples[0].transformation_version, historyTransformationVersion);
  assert.equal(missing.samples[0].normalized_observation_id, calculateNormalizedObservationId(rawHistoryId, historyTransformationVersion));
  assert.equal(masked.failures.some((failure) => failure.category === "normalized_retry_conflict"), false);
});

test("missing archive-line references and normalized rows are explicit failures", async () => {
  const data = fixture();
  const fake = createFakeDatabaseReader({
    state: seededState({
      data,
      omitReferences: [`${data.history.archive.sha256}:1`],
      omitNormalized: [`${data.live.archive.sha256}:2`]
    })
  });
  const r2 = createFakeR2Reader({ fixtures: [data.history, data.live] });
  const report = await runHostedNormalizedAudit(auditInputs({
    data,
    git: { historyArchives: [data.history.archive], liveArchives: [data.live.archive], runs: [data.live.run] },
    readers: { database: fake.reader, r2 }
  }));

  assert.equal(report.status, "failed");
  assert.equal(report.counts.archive_line_references_missing, 1);
  assert.equal(report.counts.normalized_missing, 1);
  assert.ok(report.failures.some((failure) => failure.category === "archive_line_reference_missing"));
  assert.ok(report.failures.some((failure) => failure.category === "normalized_observation_missing"));
});

test("a conflicting persisted reference fails a retry closed", async () => {
  const data = fixture();
  const fake = createFakeDatabaseReader({
    state: seededState({
      data,
      referenceOverrides: { [`${data.history.archive.sha256}:1`]: { source_name: "other_snapshot.csv" } }
    })
  });
  const r2 = createFakeR2Reader({ fixtures: [data.history, data.live] });
  const report = await runHostedNormalizedAudit(auditInputs({
    data,
    git: { historyArchives: [data.history.archive], liveArchives: [data.live.archive], runs: [data.live.run] },
    readers: { database: fake.reader, r2 }
  }));

  assert.equal(report.status, "failed");
  assert.equal(report.counts.archive_line_references_conflicting, 1);
  const conflict = report.failures.find((failure) => failure.category === "archive_line_reference_conflict");
  assert.deepEqual(conflict.samples[0].fields, ["source_name"]);
  assert.equal(conflict.samples[0].actual.source_name, "other_snapshot.csv");
});

test("semantic mismatches detect access mode, closed zero, timezone and version drift", async () => {
  const cases = [
    { name: "access mode", override: { access_mode: "single_rider" }, fields: ["access_mode"] },
    { name: "closed zero", override: { is_open: false, observed_wait_time_minutes: 0 }, fields: ["is_open", "observed_wait_time_minutes"] },
    { name: "timezone", override: { park_timezone: "UTC" }, fields: ["park_timezone"] }
  ];
  for (const testCase of cases) {
    const data = fixture();
    const fake = createFakeDatabaseReader({
      state: seededState({
        data,
        normalizedOverrides: { [`${data.history.archive.sha256}:1`]: testCase.override }
      })
    });
    const r2 = createFakeR2Reader({ fixtures: [data.history, data.live] });
    const report = await runHostedNormalizedAudit(auditInputs({
      data,
      git: { historyArchives: [data.history.archive], liveArchives: [data.live.archive], runs: [data.live.run] },
      readers: { database: fake.reader, r2 }
    }));

    assert.equal(report.status, "failed", testCase.name);
    const conflict = report.failures.find((failure) => failure.category === "normalized_retry_conflict");
    assert.ok(conflict, testCase.name);
    for (const field of testCase.fields) assert.ok(conflict.samples[0].fields.includes(field), `${testCase.name}:${field}`);
  }

  const data = fixture();
  const state = seededState({ data });
  state.normalized.push({
    ...expectedRecords(data.history)[0].normalizedObservation,
    transformation_version: liveTransformationVersion
  });
  const versionReport = await runHostedNormalizedAudit(auditInputs({
    data,
    git: { historyArchives: [data.history.archive], liveArchives: [data.live.archive], runs: [data.live.run] },
    readers: {
      database: createFakeDatabaseReader({ state }).reader,
      r2: createFakeR2Reader({ fixtures: [data.history, data.live] })
    }
  }));
  assert.equal(versionReport.status, "failed");
  assert.ok(versionReport.failures.some((failure) => failure.category === "normalized_transformation_version_unexpected"));
});

test("source health uses composite (source_name, run_id) identity", async () => {
  const data = fixture();

  const unrelatedSource = await runHostedNormalizedAudit(auditInputs({
    data,
    git: { historyArchives: [data.history.archive], liveArchives: [data.live.archive], runs: [data.live.run] },
    readers: {
      database: createFakeDatabaseReader({
        state: seededState({ data, sourceHealth: [sourceHealthFor(data.live, { source_name: "unrelated-source" })] })
      }).reader,
      r2: createFakeR2Reader({ fixtures: [data.history, data.live] })
    }
  }));
  assert.equal(unrelatedSource.status, "failed");
  assert.equal(unrelatedSource.source_health.missing_runs, 1);
  assert.ok(unrelatedSource.failures.some((failure) => failure.category === "source_health_run_missing"));

  const duplicated = await runHostedNormalizedAudit(auditInputs({
    data,
    git: { historyArchives: [data.history.archive], liveArchives: [data.live.archive], runs: [data.live.run] },
    readers: {
      database: createFakeDatabaseReader({
        state: seededState({ data, sourceHealth: [sourceHealthFor(data.live), sourceHealthFor(data.live)] })
      }).reader,
      r2: createFakeR2Reader({ fixtures: [data.history, data.live] })
    }
  }));
  assert.equal(duplicated.status, "failed");
  assert.equal(duplicated.source_health.duplicate_runs, 1);
  assert.ok(duplicated.failures.some((failure) => failure.category === "source_health_duplicate_row"));

  const driftedContext = await runHostedNormalizedAudit(auditInputs({
    data,
    git: { historyArchives: [data.history.archive], liveArchives: [data.live.archive], runs: [data.live.run] },
    readers: {
      database: createFakeDatabaseReader({
        state: seededState({ data, sourceHealth: [sourceHealthFor(data.live, { adapter_version: "other-adapter.v1" })] })
      }).reader,
      r2: createFakeR2Reader({ fixtures: [data.history, data.live] })
    }
  }));
  assert.equal(driftedContext.status, "failed");
  const mismatch = driftedContext.failures.find((failure) => failure.category === "source_health_run_mismatch");
  assert.ok(mismatch.samples[0].fields.includes("adapter_version"));
});

test("Git fallback and source-health gaps are explicit and categorized", async () => {
  const data = fixture();
  const runs = ["run-missing", "run-mismatched", "run-outage"].map((runId) => ({
    ...data.live.run,
    run_id: runId
  }));
  const fake = createFakeDatabaseReader({
    state: seededState({
      data,
      sourceHealth: [
        sourceHealthFor(data.live, {
          run_id: "run-mismatched",
          payload_sha256: "0".repeat(64)
        }),
        sourceHealthFor(data.live, {
          run_id: "run-outage",
          source_status: "outage",
          error_type: "adapter_error"
        })
      ]
    })
  });
  const r2 = createFakeR2Reader({ fixtures: [data.history, data.live] });
  const report = await runHostedNormalizedAudit(auditInputs({
    data,
    git: {
      historyArchives: [data.history.archive],
      liveArchives: [{ ...data.live.archive, run_ids: runs.map((run) => run.run_id) }],
      runs
    },
    readers: { database: fake.reader, r2 }
  }));

  assert.equal(report.status, "failed");
  assert.equal(report.source_health.expected_runs, 3);
  assert.equal(report.source_health.missing_runs, 1);
  assert.equal(report.source_health.outage_runs, 1);
  assert.equal(report.source_health.mismatched_runs, 1);
  assert.equal(report.source_health.matched_runs, 0);
  assert.equal(report.source_health.failed_runs, 3);
  assert.ok(report.failures.some((failure) => failure.category === "source_health_run_missing"));
  assert.ok(report.failures.some((failure) => failure.category === "source_health_run_mismatch"));
  assert.ok(report.failures.some((failure) => failure.category === "source_health_outage"));
});

test("raw baseline growth fails the audit and reports new raw rows", async () => {
  const data = fixture();
  const fake = createFakeDatabaseReader({
    state: seededState({ data, counts: { raw_archives: 6, raw_observations: 468 } })
  });
  const r2 = createFakeR2Reader({ fixtures: [data.history, data.live] });
  const report = await runHostedNormalizedAudit(auditInputs({
    data,
    git: { historyArchives: [data.history.archive], liveArchives: [data.live.archive], runs: [data.live.run] },
    readers: { database: fake.reader, r2 }
  }));

  assert.equal(report.status, "failed");
  assert.equal(report.raw_baseline.unchanged, false);
  assert.equal(report.raw_baseline.new_raw_rows, 28);
  assert.ok(report.failures.some((failure) => failure.category === "raw_baseline_growth"));
});

test("diagnostics redact URL credentials and secret query values", async () => {
  const data = fixture();
  const secret = "postgres://user:supersecret@validation.example:5432/neon?password=hunter2&token=abc123";
  const r2 = createFakeR2Reader({
    fixtures: [data.history, data.live],
    overrides: { getError: new Error(`connection failed for ${secret}`) }
  });
  const report = await runHostedNormalizedAudit(auditInputs({
    data,
    git: { historyArchives: [data.history.archive], liveArchives: [data.live.archive], runs: [data.live.run] },
    readers: {
      database: createFakeDatabaseReader({ state: seededState({ data }) }).reader,
      r2
    }
  }));

  assert.equal(report.status, "failed");
  const serialized = JSON.stringify(report.failures);
  assert.ok(serialized.includes("[redacted]"));
  for (const value of ["supersecret", "hunter2", "abc123"]) {
    assert.equal(serialized.includes(value), false, value);
  }
  assertSchemaConformance(report, await loadSchema());
});

test("report schema enforces passed, failed and blocked conditionals", async () => {
  const schema = await loadSchema();
  const data = fixture();
  const passReport = await runHostedNormalizedAudit(auditInputs({
    data,
    git: { historyArchives: [data.history.archive], liveArchives: [data.live.archive], runs: [data.live.run] },
    readers: {
      database: createFakeDatabaseReader({ state: seededState({ data }) }).reader,
      r2: createFakeR2Reader({ fixtures: [data.history, data.live] })
    }
  }));
  assert.equal(passReport.status, "passed");
  assertSchemaConformance(passReport, schema);
  assert.throws(() => assertSchemaConformance({ ...passReport, connections_opened: false }, schema));
  assert.throws(() => assertSchemaConformance({ ...passReport, complete: false }, schema));
  assert.throws(() => assertSchemaConformance({ ...passReport, capacity: { ...passReport.capacity, within_threshold: false } }, schema));
  assert.throws(() => assertSchemaConformance({ ...passReport, capacity: null }, schema));
  assert.throws(() => assertSchemaConformance({ ...passReport, target: null }, schema));

  const blockedReport = buildOfflineAuditReport({ checkedAt });
  assertSchemaConformance(blockedReport, schema);
  // Blocked-shaped report relabeled as passed must be rejected.
  assert.throws(() => assertSchemaConformance({ ...blockedReport, status: "passed" }, schema), /passed|mode|target/);
  assert.throws(() => assertSchemaConformance({ ...blockedReport, connections_opened: true }, schema));
  assert.throws(() => assertSchemaConformance({ ...blockedReport, blockers: [] }, schema));
  assert.throws(() => assertSchemaConformance({ ...blockedReport, status: "unknown" }, schema));
  assert.throws(() => assertSchemaConformance({ ...blockedReport, unexpected: true }, schema));

  const failedReport = { ...blockedReport, status: "failed", complete: false };
  assert.throws(() => assertSchemaConformance(failedReport, schema), "a failure-less failed report must be rejected");
  assert.ok(failedReport.failures.length === 0);
});

/* ------------------------------------------------------------------ */
/* Fixtures and fakes                                                 */
/* ------------------------------------------------------------------ */

function fixture() {
  const history = makeArchiveFixture({
    fileSourceName: "wait_times_2026-09-28.csv",
    rows: [
      csvRow("ride-1", "Fixture Ride", true, 30),
      csvRow("ride-2", "Fixture Ride", true, 20)
    ],
    transformationVersion: historyTransformationVersion
  });
  const live = makeArchiveFixture({
    fileSourceName: "wait_times_snapshot_20260930001500.csv",
    rows: [
      csvRow("ride-1", "Fixture Ride", true, 25),
      csvRow("ride-2", "Fixture Ride", true, 15)
    ],
    transformationVersion: liveTransformationVersion
  });
  const liveRunId = "run-live-1";
  live.archive.run_id = liveRunId;
  live.run = {
    run_id: liveRunId,
    source_name: liveSourceName,
    status: "written",
    payload_sha256: live.archive.sha256,
    record_count: live.rows.length,
    observed_at: "2026-09-30T00:15:00.000Z",
    adapter_version: "bootstrap-collector-adapter.v1",
    schema_version: rawSchemaVersion,
    deduplication_key: live.archive.sha256
  };
  return { history, live };
}

function makeArchiveFixture({ fileSourceName, rows, transformationVersion }) {
  const content = Buffer.from(serializeCsv(rows), "utf8");
  const sha256 = sha256Hex(content);
  const archive = {
    raw_archive_id: sha256,
    sha256,
    source_name: fileSourceName,
    byte_size: content.byteLength,
    row_count: rows.length,
    transformation_version: transformationVersion
  };
  return {
    archive,
    content,
    rows,
    key: `wait-times/${sha256}/${fileSourceName}`
  };
}

function csvRow(rideId, rideName, isOpen, wait) {
  return {
    snapshot_utc: "2026-09-30T00:15:00.000Z",
    snapshot_park_datetime: "2026-09-29 17:15:00",
    snapshot_park_date: "2026-09-29",
    snapshot_timezone: "America/Los_Angeles",
    park_id: "dca",
    park_name: "Disney California Adventure",
    land: "Fixture Land",
    ride_id: rideId,
    ride_name: rideName,
    is_open: isOpen ? "TRUE" : "FALSE",
    wait_time_minutes: wait === null ? "" : String(wait),
    source_last_updated_utc: "2026-09-30T00:14:00.000Z",
    source_last_updated_park_datetime: "2026-09-29 17:14:00",
    source_url: "https://queue-times.example/ride"
  };
}

function serializeCsv(rows) {
  const columns = Object.keys(rows[0]);
  const encode = (value) => {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `${columns.join(",")}\n${rows.map((row) => columns.map((column) => encode(row[column])).join(",")).join("\n")}\n`;
}

function expectedRecords(fixtureData, normalizedOverrides = {}) {
  const catalog = catalogSnapshot();
  const parsed = parseCsv(fixtureData.content.toString("utf8"));
  return parsed.map((row, index) => {
    const ordinal = index + 1;
    const rawObservation = {
      contract_version: rawSchemaVersion,
      raw_observation_id: calculateRawObservationId(fixtureData.archive.sha256, ordinal),
      raw_archive_id: fixtureData.archive.raw_archive_id,
      source_row_number: ordinal,
      snapshot_utc: row.snapshot_utc,
      snapshot_park_datetime: row.snapshot_park_datetime,
      snapshot_park_date: row.snapshot_park_date,
      snapshot_timezone: row.snapshot_timezone,
      park_id: row.park_id,
      park_name: row.park_name,
      land: row.land,
      ride_id: row.ride_id,
      ride_name: row.ride_name,
      is_open: /^true$/i.test(row.is_open),
      wait_time_minutes: row.wait_time_minutes === "" ? null : Number(row.wait_time_minutes),
      source_last_updated_utc: row.source_last_updated_utc,
      source_last_updated_park_datetime: row.source_last_updated_park_datetime,
      source_url: row.source_url
    };
    const archiveLineReference = {
      contract_version: "raw-archive-line-reference.v1",
      raw_observation_id: rawObservation.raw_observation_id,
      raw_archive_id: fixtureData.archive.raw_archive_id,
      r2_uri: `s3://${bucket}/${fixtureData.key}`,
      archive_sha256: fixtureData.archive.sha256,
      archive_byte_size: fixtureData.archive.byte_size,
      source_line_number: ordinal,
      source_name: fixtureData.archive.source_name,
      archive_schema_version: rawSchemaVersion
    };
    const normalizedObservation = normalizeArchivedWaitObservation({
      rawObservation,
      archiveLineReference,
      catalogEntries: catalog.entries,
      accessMode: "standby",
      generatedAt: checkedAt,
      transformationVersion: fixtureData.archive.transformation_version
    });
    return {
      key: `${fixtureData.archive.sha256}:${ordinal}`,
      ordinal,
      rawObservation,
      archiveLineReference,
      normalizedObservation: { ...normalizedObservation, ...(normalizedOverrides[ordinal] || {}) }
    };
  });
}

function seededState(options = {}) {
  const data = options.data || fixture();
  const records = [...expectedRecords(data.history), ...expectedRecords(data.live)];
  const omitReferences = new Set(options.omitReferences || []);
  const omitNormalized = new Set(options.omitNormalized || []);
  const references = records
    .filter((record) => !omitReferences.has(record.key))
    .map((record) => ({
      ...record.archiveLineReference,
      ...((options.referenceOverrides || {})[record.key] || {})
    }));
  const normalized = records
    .filter((record) => !omitNormalized.has(record.key))
    .map((record) => ({
      ...record.normalizedObservation,
      ...((options.normalizedOverrides || {})[record.key] || {})
    }));
  normalized.push(...(options.extraNormalized || []));
  return {
    presentRelations: options.presentRelations || new Set(requiredRelations),
    counts: options.counts || {
      raw_archives: 5,
      raw_observations: 440,
      normalized_v2: records.length,
      archive_line_references: records.length,
      catalog_entries: 1,
      source_health: 1
    },
    sourceHealth: options.sourceHealth || [sourceHealthFor(data.live)],
    references,
    normalized
  };
}

function sourceHealthFor(live, overrides = {}) {
  return {
    source_name: live.run.source_name,
    run_id: live.run.run_id,
    source_status: "ok",
    payload_sha256: live.archive.sha256,
    record_count: live.rows.length,
    fallback_status: "written",
    hosted_write_status: "written",
    adapter_version: live.run.adapter_version,
    schema_version: live.run.schema_version,
    envelope_id: live.run.deduplication_key,
    error_type: null,
    ...overrides
  };
}

function createFakeDatabaseReader({ state, failOn = null } = {}) {
  const sessions = [];
  const writes = [];
  let closed = 0;
  const forbidden = /^(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|COMMIT|BEGIN\s+(?!TRANSACTION\s+READ\s+ONLY))/i;
  const client = {
    async query(sql, params = []) {
      const statement = String(sql).trim();
      if (forbidden.test(statement)) {
        writes.push(statement);
        throw new Error(`forbidden write statement: ${statement}`);
      }
      if (failOn && failOn.test(statement)) throw new Error("synthetic query failure");
      if (statement === "BEGIN TRANSACTION READ ONLY" || statement === "ROLLBACK") return { rows: [] };
      if (statement.includes("to_regclass")) {
        const row = {};
        for (const [index, relation] of params.entries()) {
          row[relationAlias(relation, index)] = state.presentRelations.has(relation) ? relation : null;
        }
        return { rows: [row] };
      }
      if (statement.includes("FROM ingestion.raw_archives) AS raw_archives")) {
        return { rows: [{ ...state.counts }] };
      }
      if (statement.includes("FROM ingestion.source_health")) {
        const pairs = new Set();
        for (let index = 0; index < params.length; index += 2) {
          pairs.add(sourceHealthKey(params[index], params[index + 1]));
        }
        return {
          rows: state.sourceHealth.filter((record) =>
            pairs.has(sourceHealthKey(record.source_name, record.run_id)))
        };
      }
      if (statement.includes("FROM ingestion.raw_archive_line_references")) {
        const ids = new Set(params[0]);
        return { rows: state.references.filter((record) => ids.has(record.raw_observation_id)) };
      }
      if (statement.includes("FROM observations.normalized_wait_observations_v2")) {
        const whereClause = statement.split(/WHERE/i)[1] || "";
        if (whereClause.includes("raw_observation_id")) {
          throw new Error("normalized rows must be looked up by normalized primary key, not raw_observation_id");
        }
        const ids = new Set(params[0]);
        return { rows: state.normalized.filter((record) => ids.has(record.normalized_observation_id)) };
      }
      throw new Error(`unexpected audit SQL: ${statement}`);
    }
  };
  return {
    sessions,
    writes,
    get closed() { return closed; },
    reader: {
      async withReadOnlyTransaction(operation) {
        const session = { statements: [] };
        sessions.push(session);
        const query = (sql, params) => {
          const statement = String(sql).trim();
          session.statements.push(statement);
          return client.query(statement, params);
        };
        await query("BEGIN TRANSACTION READ ONLY");
        try {
          return await operation({ query });
        } finally {
          await query("ROLLBACK");
        }
      },
      async close() { closed += 1; }
    }
  };
}

function createFakePool({ beginError = null, failRollback = false, failFirstRollbackOnly = false } = {}) {
  const events = [];
  const releases = [];
  const rollbackError = Object.assign(new Error("rollback failed"), { code: "ROLLBACK_FAILED" });
  let rollbackCalls = 0;
  const client = {
    async query(sql) {
      events.push(sql);
      if (sql === "BEGIN TRANSACTION READ ONLY" && beginError) throw beginError;
      if (sql === "ROLLBACK") {
        rollbackCalls += 1;
        if (failRollback) throw rollbackError;
        if (failFirstRollbackOnly && rollbackCalls === 1) throw rollbackError;
      }
      return { rows: [] };
    },
    release(error) { releases.push(error ?? null); }
  };
  const pool = {
    async connect() { return client; },
    async end() { events.push("end"); }
  };
  return {
    pool,
    events,
    releases,
    rollbackError,
    get rollbackCalls() { return rollbackCalls; }
  };
}

async function captureRejection(run) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to reject");
}

function relationAlias(relation, index) {
  return requiredRelations.includes(relation)
    ? ["raw_archives", "raw_wait_observations", "archive_line_references", "normalized_v2", "catalog_entries", "source_health"][index]
    : `relation_${index}`;
}

function createFakeR2Reader({ fixtures = [], extraListed = [], overrides = {} } = {}) {
  const calls = [];
  const byKey = new Map(fixtures.map((item) => [item.key, item]));
  const listed = overrides.listed || [
    ...fixtures.map((item) => ({
      key: item.key,
      bucket,
      size: overrides.listSize ?? item.archive.byte_size
    })),
    ...extraListed.map((key) => ({ key, bucket, size: 10 }))
  ];
  return {
    calls,
    async listObjects({ prefix } = {}) {
      calls.push({ type: "list", prefix });
      return listed;
    },
    async headObject({ key }) {
      calls.push({ type: "head", key });
      const item = byKey.get(key);
      if (!item) throw new Error(`missing fixture object ${key}`);
      return {
        contentLength: overrides.headByteSize ?? item.archive.byte_size,
        metadata: {
          sha256: overrides.metadataSha256 || item.archive.sha256,
          schema_version: overrides.metadataSchemaVersion || rawSchemaVersion
        }
      };
    },
    async getObject({ key }) {
      calls.push({ type: "get", key });
      if (overrides.getError) throw overrides.getError;
      const item = byKey.get(key);
      if (!item) throw new Error(`missing fixture object ${key}`);
      return overrides.content || item.content;
    },
    async putObject() {
      calls.push({ type: "put" });
      throw new Error("PutObject is forbidden in the read-only audit");
    },
    async deleteObject() {
      calls.push({ type: "delete" });
      throw new Error("DeleteObject is forbidden in the read-only audit");
    },
    async close() { calls.push({ type: "close" }); }
  };
}

function auditInputs(overrides = {}) {
  const data = overrides.data || fixture();
  const inputs = {
    checkedAt,
    runId: "audit-test-run",
    mode: "live-read-only",
    targetName: "synthetic-validation-target-2026-10",
    databaseUrl,
    targetFingerprint,
    authorization: readOnlyAuthorization(),
    catalogSnapshot: catalogSnapshot(),
    accessModeMapping: accessModeMapping(),
    git: {
      historyArchives: [data.history.archive],
      liveArchives: [data.live.archive],
      runs: [data.live.run]
    },
    baseline: { archives: 5, raw_observations: 440, normalized_observations: 0 },
    capacity: capacityEvidence()
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && key !== "data") inputs[key] = value;
  }
  return inputs;
}

function readOnlyAuthorization(overrides = {}) {
  return {
    kind: "read-only-validation",
    approvedBy: "synthetic-test-reviewer",
    approvedAt: "2026-09-30T00:00:00.000Z",
    expiresAt: "2026-12-31T00:00:00.000Z",
    targetFingerprint,
    ...overrides
  };
}

function capacityEvidence(overrides = {}) {
  return {
    measurementId: "synthetic-measurement",
    measuredAt: checkedAt,
    usedBytes: 1000,
    maxCapacityBytes: 1_000_000,
    stopThresholdBytes: 900_000,
    reservedHeadroomBytes: 50_000,
    targetFingerprint,
    ...overrides
  };
}

function catalogSnapshot() {
  return {
    status: "reviewed",
    catalog_version: "synthetic-audit-catalog.v1",
    reviewed_by: "synthetic-test-reviewer",
    reviewed_at: checkedAt,
    entries: [{
      contract_version: "catalog-entry.v1",
      operator_id: "disney",
      resort_id: "disneyland-resort",
      park_id: "dca",
      aliases: ["Fixture Ride"],
      canonical_attraction_id: "dca-fixture-ride",
      canonical_attraction_name: "Fixture Ride",
      canonical_category: "attraction",
      lifecycle: {
        contract_version: "catalog-attraction-lifecycle.v1",
        canonical_attraction_id: "dca-fixture-ride",
        park_id: "dca",
        park_timezone: "America/Los_Angeles",
        wait_capability: "posted_standby",
        supported_access_modes: ["standby"],
        operational_state: "unknown",
        training_disposition: "review_required",
        planning_disposition: "review_required",
        evidence: [{
          source_type: "manual_review",
          source_url: null,
          verified_at: checkedAt,
          reviewed_by: "synthetic-test-reviewer",
          notes: "Synthetic fixture only; not authoritative park evidence."
        }],
        valid_from: "2026-01-01",
        valid_to: null,
        catalog_version: "synthetic-audit-catalog.v1",
        generated_at: checkedAt
      }
    }]
  };
}

function accessModeMapping(overrides = {}) {
  return {
    status: "reviewed",
    catalog_version: "synthetic-audit-catalog.v1",
    reviewed_by: "synthetic-test-reviewer",
    reviewed_at: checkedAt,
    mappings: [
      { park_id: "dca", ride_id: "ride-1", access_mode: "standby" },
      { park_id: "dca", ride_id: "ride-2", access_mode: "standby" }
    ],
    ...overrides
  };
}

function sourceHealthKey(sourceName, runId) {
  return `${sourceName}\u001f${runId}`;
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function loadSchema() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  return JSON.parse(await readFile(
    path.join(root, "packages/contracts/schemas/v1/hosted-normalized-audit-report.schema.json"),
    "utf8"
  ));
}

function assertSchemaConformance(value, schema, rootSchema, location = "$") {
  if (rootSchema === undefined) rootSchema = schema;
  schema = resolveSchemaReference(schema, rootSchema);
  if (schema.allOf) {
    for (const [index, branch] of schema.allOf.entries()) {
      assertSchemaConformance(value, branch, rootSchema, `${location}#allOf[${index}]`);
    }
  }
  if (schema.if) {
    let ifMatches = true;
    try {
      assertSchemaConformance(value, schema.if, rootSchema, `${location}#if`);
    } catch {
      ifMatches = false;
    }
    if (ifMatches && schema.then) {
      assertSchemaConformance(value, schema.then, rootSchema, `${location}#then`);
    }
    if (!ifMatches && schema.else) {
      assertSchemaConformance(value, schema.else, rootSchema, `${location}#else`);
    }
  }
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
  if (typeof value === "number") {
    if (schema.minimum !== undefined) assert.ok(value >= schema.minimum, `${location} is below its minimum`);
    if (schema.maximum !== undefined) assert.ok(value <= schema.maximum, `${location} is above its maximum`);
    if (schema.exclusiveMinimum !== undefined) assert.ok(value > schema.exclusiveMinimum, `${location} is not above its exclusive minimum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined) assert.ok(value.length >= schema.minItems, `${location} has too few items`);
    if (schema.maxItems !== undefined) assert.ok(value.length <= schema.maxItems, `${location} has too many items`);
    if (schema.items) {
      value.forEach((item, index) => assertSchemaConformance(item, schema.items, rootSchema, `${location}[${index}]`));
    }
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
