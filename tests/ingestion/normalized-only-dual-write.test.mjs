import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPostgresArchiveLineReferenceRepository } from "../../infra/archive-line-reference-postgres.mjs";
import { createPostgresCatalogRepository } from "../../infra/catalog-postgres.mjs";
import {
  createPostgresNormalizedObservationRepository,
  withPostgresStorageTransaction
} from "../../infra/normalized-observations-postgres.mjs";
import {
  calculateDatabaseFingerprint,
  normalizedOnlyTransformationVersion
} from "../../infra/normalized-only-hosted-write.mjs";
import { createPostgresSourceHealthRepository } from "../../infra/source-health-postgres.mjs";
import { resolveSidecarExitCode, runBootstrapDualWrite, runBootstrapSourceFailure } from "../../workers/collector/run-dual-write.mjs";
import { DualWriteError } from "../../workers/collector/dual-write.mjs";

const targetFingerprint = "a".repeat(64);
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

const snapshotRow = {
  snapshot_utc: "2026-07-01T15:00:00.000Z",
  snapshot_park_datetime: "2026-07-01 08:00:00",
  snapshot_park_date: "2026-07-01",
  snapshot_timezone: "America/Los_Angeles",
  park_id: "dca",
  park_name: "Disney California Adventure",
  land: "Fixture Land",
  ride_id: "ride-1",
  ride_name: "Fixture Ride",
  is_open: "TRUE",
  wait_time_minutes: "25",
  source_last_updated_utc: "2026-07-01T14:59:00.000Z",
  source_last_updated_park_datetime: "2026-07-01 07:59:00",
  source_url: "https://queue-times.example/ride"
};

function fixedClock() {
  let calls = 0;
  return () => new Date(`2026-07-01T15:0${calls++}:00.000Z`);
}

function catalogSnapshot(overrides = {}) {
  return {
    status: "reviewed",
    catalog_version: "synthetic-normalized-sidecar-catalog.v1",
    reviewed_by: "synthetic-test-reviewer",
    reviewed_at: "2026-06-30T00:00:00.000Z",
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
          verified_at: "2026-06-30T00:00:00.000Z",
          reviewed_by: "synthetic-test-reviewer",
          notes: "Synthetic fixture only; not authoritative park evidence."
        }],
        valid_from: "2026-01-01",
        valid_to: null,
        catalog_version: "synthetic-normalized-sidecar-catalog.v1",
        generated_at: "2026-06-30T00:00:00.000Z"
      }
    }],
    ...overrides
  };
}

function accessModeMapping(overrides = {}) {
  return {
    status: "reviewed",
    catalog_version: "synthetic-normalized-sidecar-catalog.v1",
    reviewed_by: "synthetic-test-reviewer",
    reviewed_at: "2026-06-30T00:00:00.000Z",
    mappings: [{ park_id: "dca", ride_id: "ride-1", access_mode: "standby" }],
    ...overrides
  };
}

function authorization(overrides = {}) {
  return {
    kind: "validation-only",
    approvedBy: "synthetic-test-reviewer",
    approvedAt: "2026-06-30T00:00:00.000Z",
    expiresAt: "2026-10-31T00:00:00.000Z",
    targetFingerprint,
    ...overrides
  };
}

function hostedConfig(overrides = {}) {
  return {
    bucket: "normalized-validation-bucket",
    r2: createFakeR2(),
    database: createFakeStorageDatabase().database,
    catalogSnapshot: catalogSnapshot(),
    accessModeMapping: accessModeMapping(),
    authorization: authorization(),
    expectedTargetFingerprint: targetFingerprint,
    targetFingerprint,
    ...overrides
  };
}

test("disabled normalized-only sidecar keeps Git-only behavior and never opens hosted ports", async (t) => {
  const sandbox = await makeSidecarSandbox(t);
  const r2 = createFakeR2();
  const storage = createFakeStorageDatabase();
  let storedHealth = null;
  const result = await runBootstrapDualWrite({
    rootDir: sandbox,
    enabled: false,
    environment: {},
    clock: fixedClock(),
    log: false,
    normalizedOnlyHosted: hostedConfig({ r2, database: storage.database }),
    sourceHealthRepository: { async upsertSourceHealth(record) { storedHealth = record; } }
  });

  assert.equal(result.fallback.status, "written");
  assert.equal(result.hosted.status, "disabled");
  assert.equal(result.failure_reason, null);
  assert.equal(result.source_health.status, "written");
  assert.equal(storedHealth.hosted_write_status, "disabled");
  assert.equal(r2.calls.length, 0);
  assert.equal(storage.transactionCount, 0);
});

test("Git fallback failure stops the normalized-only hosted leg before any port call", async (t) => {
  const sandbox = await makeSidecarSandbox(t);
  const r2 = createFakeR2();
  const storage = createFakeStorageDatabase();
  let storedHealth = null;

  await assert.rejects(
    () => runBootstrapDualWrite({
      rootDir: sandbox,
      enabled: true,
      environment: {
        COLLECTOR_RUN_ID: "run-git-failure",
        COLLECTOR_GIT_FALLBACK_OUTCOME: "failure"
      },
      clock: fixedClock(),
      log: false,
      normalizedOnlyHosted: hostedConfig({ r2, database: storage.database }),
      sourceHealthRepository: { async upsertSourceHealth(record) { storedHealth = record; } }
    }),
    (error) => {
      assert.equal(error instanceof DualWriteError, true);
      assert.equal(error.result.fallback.status, "failed");
      assert.equal(error.result.hosted.status, "not_attempted");
      return true;
    }
  );

  assert.equal(r2.calls.length, 0);
  assert.equal(storage.transactionCount, 0);
  assert.equal(storedHealth.fallback_status, "failed");
  assert.equal(storedHealth.hosted_write_status, "not_attempted");
});

test("missing reviewed inputs fail the hosted leg visibly while Git remains successful", async (t) => {
  const sandbox = await makeSidecarSandbox(t);
  const storage = createFakeStorageDatabase();
  const config = hostedConfig({ catalogSnapshot: undefined, database: storage.database });
  const result = await runBootstrapDualWrite({
    rootDir: sandbox,
    enabled: true,
    environment: { COLLECTOR_RUN_ID: "run-missing-inputs" },
    clock: fixedClock(),
    log: false,
    normalizedOnlyHosted: config,
    sourceHealthRepository: { async upsertSourceHealth() {} }
  });

  assert.equal(result.fallback.status, "written");
  assert.equal(result.hosted.status, "failed");
  assert.equal(result.failure_reason, "hosted_write_failed");
  assert.match(result.hosted.error.message, /reviewed_catalog_entry_v1_snapshot_required/);
  assert.equal(config.r2.calls.length, 0);
  assert.equal(storage.transactionCount, 0);
});

test("expired or mismatched authorization blocks hosted writes before schema and R2 access", async (t) => {
  const sandbox = await makeSidecarSandbox(t);
  const expiredStorage = createFakeStorageDatabase();
  const expiredConfig = hostedConfig({
    authorization: authorization({ expiresAt: "2026-06-30T00:00:00.000Z" }),
    database: expiredStorage.database
  });
  const expired = await runBootstrapDualWrite({
    rootDir: sandbox,
    enabled: true,
    environment: { COLLECTOR_RUN_ID: "run-expired-authorization" },
    clock: fixedClock(),
    log: false,
    normalizedOnlyHosted: expiredConfig,
    sourceHealthRepository: { async upsertSourceHealth() {} }
  });
  assert.equal(expired.fallback.status, "written");
  assert.equal(expired.hosted.status, "failed");
  assert.match(expired.hosted.error.message, /authorization_expired/);
  assert.equal(expiredConfig.r2.calls.length, 0);
  assert.equal(expiredStorage.transactionCount, 0);

  const mismatchedConfig = hostedConfig({
    authorization: authorization({ targetFingerprint: "b".repeat(64) })
  });
  const mismatched = await runBootstrapDualWrite({
    rootDir: sandbox,
    enabled: true,
    environment: { COLLECTOR_RUN_ID: "run-target-mismatch" },
    clock: fixedClock(),
    log: false,
    normalizedOnlyHosted: mismatchedConfig,
    sourceHealthRepository: { async upsertSourceHealth() {} }
  });
  assert.equal(mismatched.fallback.status, "written");
  assert.equal(mismatched.hosted.status, "failed");
  assert.match(mismatched.hosted.error.message, /target_fingerprint_mismatch/);
  assert.equal(mismatchedConfig.r2.calls.length, 0);
});

test("schema-not-ready blocks the hosted leg before R2 upload or transaction", async (t) => {
  const sandbox = await makeSidecarSandbox(t);
  const storage = createFakeStorageDatabase({ schemaReady: false });
  const config = hostedConfig({ database: storage.database });
  const result = await runBootstrapDualWrite({
    rootDir: sandbox,
    enabled: true,
    environment: { COLLECTOR_RUN_ID: "run-schema-not-ready" },
    clock: fixedClock(),
    log: false,
    normalizedOnlyHosted: config,
    sourceHealthRepository: { async upsertSourceHealth() {} }
  });

  assert.equal(result.fallback.status, "written");
  assert.equal(result.hosted.status, "failed");
  assert.match(result.hosted.error.message, /relations are not present/);
  assert.equal(config.r2.calls.length, 0, "schema readiness is checked before any R2 write");
  assert.equal(storage.transactionCount, 0);
});

test("R2 upload failure keeps Git successful and never opens a Neon transaction", async (t) => {
  const sandbox = await makeSidecarSandbox(t);
  const r2 = createFakeR2({ failPut: true });
  const storage = createFakeStorageDatabase();
  const result = await runBootstrapDualWrite({
    rootDir: sandbox,
    enabled: true,
    environment: { COLLECTOR_RUN_ID: "run-r2-failure" },
    clock: fixedClock(),
    log: false,
    normalizedOnlyHosted: hostedConfig({ r2, database: storage.database }),
    sourceHealthRepository: { async upsertSourceHealth() {} }
  });

  assert.equal(result.fallback.status, "written");
  assert.equal(result.hosted.status, "failed");
  assert.match(result.hosted.error.message, /immutable R2 upload failed/);
  assert.equal(storage.transactionCount, 0);
  assert.equal(storage.committed.normalized.size, 0);
});

test("Neon transaction failure rolls back every normalized write and leaves zero raw inserts", async (t) => {
  const sandbox = await makeSidecarSandbox(t);
  const r2 = createFakeR2();
  const storage = createFakeStorageDatabase({ failNormalizedInsert: true });
  const result = await runBootstrapDualWrite({
    rootDir: sandbox,
    enabled: true,
    environment: { COLLECTOR_RUN_ID: "run-transaction-rollback" },
    clock: fixedClock(),
    log: false,
    normalizedOnlyHosted: hostedConfig({ r2, database: storage.database }),
    sourceHealthRepository: { async upsertSourceHealth() {} }
  });

  assert.equal(result.fallback.status, "written");
  assert.equal(result.hosted.status, "failed");
  assert.match(result.hosted.error.message, /transaction failed and was rolled back/);
  assert.equal(storage.queries.filter(({ sql }) => sql.trim() === "BEGIN").length, 1);
  assert.equal(storage.queries.filter(({ sql }) => sql.trim() === "ROLLBACK").length, 1);
  assert.equal(storage.queries.filter(({ sql }) => sql.trim() === "COMMIT").length, 0);
  assert.equal(storage.committed.references.size, 0);
  assert.equal(storage.committed.catalogEntries.size, 0);
  assert.equal(storage.committed.normalized.size, 0);
  assert.equal(storage.committed.sourceHealth.size, 0);
  assert.equal(storage.rawInsertAttempts, 0);
  assert.equal(r2.objects.size, 1, "the immutable R2 object may already exist after a rolled-back DB write");
});

test("normalized-only success writes only catalog, lineage, normalized v2 and source health", async (t) => {
  const sandbox = await makeSidecarSandbox(t);
  const r2 = createFakeR2();
  const storage = createFakeStorageDatabase();
  const result = await runBootstrapDualWrite({
    rootDir: sandbox,
    enabled: true,
    environment: { COLLECTOR_RUN_ID: "run-normalized-success" },
    clock: fixedClock(),
    log: false,
    normalizedOnlyHosted: hostedConfig({ r2, database: storage.database }),
    sourceHealthRepository: { async upsertSourceHealth() { throw new Error("post-hoc source health must not be written on hosted success"); } }
  });

  assert.equal(result.fallback.status, "written");
  assert.equal(result.hosted.status, "written");
  assert.equal(result.source_health.status, "written");
  assert.equal(result.source_health.source_health_id, [...storage.committed.sourceHealth.values()][0].source_health_id);
  assert.equal(result.normalized_only.transformation_version, normalizedOnlyTransformationVersion);
  assert.equal(result.normalized_only.schema_version, "raw-wait-observation.v1");
  assert.equal(result.normalized_only.adapter_version, "collector-normalized-sidecar.v1");
  assert.equal(result.normalized_only.normalized_records_written, 1);
  assert.equal(result.normalized_only.raw_observation_rows_written, 0);
  assert.equal(result.normalized_only.object_uri.startsWith("s3://normalized-validation-bucket/wait-times/"), true);

  assert.equal(storage.committed.catalogEntries.size, 1);
  assert.equal(storage.committed.references.size, 1);
  assert.equal(storage.committed.normalized.size, 1);
  assert.equal(storage.committed.sourceHealth.size, 1);
  const normalized = [...storage.committed.normalized.values()][0];
  assert.equal(normalized.access_mode, "standby");
  assert.equal(normalized.observed_wait_time_minutes, 25);
  const health = [...storage.committed.sourceHealth.values()][0];
  assert.equal(health.hosted_write_status, "written");
  assert.equal(health.fallback_status, "written");
  assert.equal(health.record_count, 1);
  assert.equal(r2.objects.size, 1);
  const stored = [...r2.objects.values()][0];
  assert.equal(stored.metadata.sha256, result.deduplication_key);
  assert.equal(stored.metadata.schema_version, "raw-wait-observation.v1");
  assert.equal(storage.rawInsertAttempts, 0);
  assert.ok(storage.queries.every(({ sql }) => !/INSERT\s+INTO\s+ingestion\.raw_wait_observations/i.test(sql)));
});

test("identical retry is idempotent across R2 duplicate puts and DB semantic conflicts", async (t) => {
  const sandbox = await makeSidecarSandbox(t);
  const r2 = createFakeR2();
  const storage = createFakeStorageDatabase();
  const config = hostedConfig({ r2, database: storage.database });
  const environment = { COLLECTOR_RUN_ID: "run-idempotent-retry" };

  const first = await runBootstrapDualWrite({
    rootDir: sandbox,
    enabled: true,
    environment,
    clock: fixedClock(),
    log: false,
    normalizedOnlyHosted: config,
    sourceHealthRepository: { async upsertSourceHealth() {} }
  });
  const firstNormalizedGeneratedAt = [...storage.committed.normalized.values()][0].generated_at;

  const second = await runBootstrapDualWrite({
    rootDir: sandbox,
    enabled: true,
    environment,
    clock: fixedClock(),
    log: false,
    normalizedOnlyHosted: config,
    sourceHealthRepository: { async upsertSourceHealth() {} }
  });

  assert.equal(first.hosted.status, "written");
  assert.equal(second.hosted.status, "written");
  assert.equal(second.normalized_only.r2_object_created, false, "the duplicate R2 put is verified instead of overwritten");
  assert.equal(r2.objects.size, 1);
  assert.equal(storage.committed.normalized.size, 1);
  assert.equal(storage.committed.references.size, 1);
  assert.equal(storage.committed.catalogEntries.size, 1);
  assert.equal(storage.committed.sourceHealth.size, 1);
  assert.equal([...storage.committed.normalized.values()][0].generated_at, firstNormalizedGeneratedAt);
  assert.equal(storage.rawInsertAttempts, 0);
});

test("database fingerprint binds host, port, and database without credentials", () => {
  const first = calculateDatabaseFingerprint("postgresql://user:secret@db.example:5432/neon?sslmode=require");
  const second = calculateDatabaseFingerprint("postgres://other:different@db.example:5432/neon");
  assert.equal(first, second);
  assert.notEqual(first, calculateDatabaseFingerprint("postgres://user:secret@db.example:5432/other"));
  assert.notEqual(first, calculateDatabaseFingerprint("postgres://user:secret@other.example:5432/neon"));
  assert.throws(() => calculateDatabaseFingerprint("https://db.example/neon"), /protocol/);
});

test("database fingerprint rejects routing overrides that could redirect pg before pool creation", () => {
  const base = "postgres://user:secret@db.example:5432/neon";
  const expected = calculateDatabaseFingerprint(base);
  for (const override of ["host=evil.example", "hostaddr=10.0.0.9", "port=6543", "database=other", "db=other", "dbname=other"]) {
    assert.throws(() => calculateDatabaseFingerprint(`${base}?${override}`), /routing override/, override);
  }
  assert.equal(
    calculateDatabaseFingerprint(`${base}?sslmode=require&application_name=sidecar`),
    expected,
    "non-routing query parameters stay allowed"
  );
});

test("direct CLI exit helper surfaces hosted failure after the Git fallback already committed", () => {
  assert.equal(resolveSidecarExitCode({ hosted: { status: "written" }, source_health: { status: "written" } }), 0);
  assert.equal(resolveSidecarExitCode({ hosted: { status: "disabled" }, source_health: { status: "written" } }), 0);
  assert.equal(resolveSidecarExitCode({ hosted: { status: "not_attempted" }, source_health: { status: "not_configured" } }), 0);
  assert.equal(
    resolveSidecarExitCode({ hosted: { status: "failed", error: { message: "redacted reason" } }, source_health: { status: "written" } }),
    1,
    "hosted failure must fail the workflow step even though Git already committed"
  );
  assert.equal(resolveSidecarExitCode({ hosted: { status: "written" }, source_health: { status: "failed" } }), 1);
  assert.equal(resolveSidecarExitCode(null), 1);
});

test("disabled sidecar ignores production-shaped cloud env and never opens the hosted database", async (t) => {
  const sandbox = await makeSidecarSandbox(t);
  const environment = {
    COLLECTOR_RUN_ID: "run-disabled-cloud-env",
    DATABASE_URL: "postgres://user:secret@127.0.0.1:1/unreachable",
    RAW_ARCHIVE_BUCKET: "production-shaped-bucket",
    RAW_ARCHIVE_ENDPOINT: "https://r2.invalid",
    AWS_ACCESS_KEY_ID: "not-a-real-key",
    AWS_SECRET_ACCESS_KEY: "not-a-real-secret",
    AWS_REGION: "us-west-2"
  };
  const result = await runBootstrapDualWrite({
    rootDir: sandbox,
    enabled: false,
    environment,
    clock: fixedClock(),
    log: false
  });
  assert.equal(result.fallback.status, "written");
  assert.equal(result.hosted.status, "disabled");
  assert.equal(
    result.source_health.status,
    "not_configured",
    "disabled mode must not attempt DATABASE_URL even when it is present"
  );

  const sourceFailure = await runBootstrapSourceFailure({
    environment: { ...environment, COLLECTOR_SOURCE_FAILURE: "queue API unavailable" },
    clock: fixedClock(),
    log: false
  });
  assert.equal(sourceFailure.source_health.status, "not_configured");

  let storedHealth = null;
  const withRepository = await runBootstrapSourceFailure({
    environment: { ...environment, COLLECTOR_SOURCE_FAILURE: "queue API unavailable" },
    clock: fixedClock(),
    log: false,
    sourceHealthRepository: { async upsertSourceHealth(record) { storedHealth = record; } }
  });
  assert.equal(withRepository.source_health.status, "written", "an injected repository is still honored when disabled");
  assert.equal(storedHealth.source_status, "outage");
});

test("production wiring rejects a DATABASE_URL routing override before R2 or pool creation", async (t) => {
  const sandbox = await makeSidecarSandbox(t);
  const result = await runBootstrapDualWrite({
    rootDir: sandbox,
    enabled: true,
    environment: {
      COLLECTOR_RUN_ID: "run-routing-override",
      DATABASE_URL: "postgres://user:secret@db.example:5432/neon?host=evil.example",
      RAW_ARCHIVE_BUCKET: "validation-bucket"
    },
    clock: fixedClock(),
    log: false,
    sourceHealthRepository: { async upsertSourceHealth() {} }
  });

  assert.equal(result.fallback.status, "written");
  assert.equal(result.hosted.status, "failed");
  assert.match(result.hosted.error.message, /routing override/);
  assert.equal(result.source_health.status, "written", "failure accounting stays on the injected repository");
});

test("source-health DB fallback without current authorization is blocked before any pool", async (t) => {
  const sandbox = await makeSidecarSandbox(t);
  const pool = createRecordingPoolFactory();
  const result = await runBootstrapDualWrite({
    rootDir: sandbox,
    enabled: true,
    environment: {
      COLLECTOR_RUN_ID: "run-fallback-missing-authorization",
      DATABASE_URL: "postgres://user:secret@db.example:5432/neon",
      RAW_ARCHIVE_BUCKET: "validation-bucket"
    },
    clock: fixedClock(),
    log: false,
    createSourceHealthPool: pool.factory
  });

  assert.equal(result.fallback.status, "written");
  assert.equal(result.hosted.status, "failed");
  assert.equal(result.source_health.status, "blocked");
  assert.equal(result.source_health.error.type, "source_health_fallback_blocked");
  assert.match(result.source_health.error.message, /current_validation_only_authorization_required/);
  assert.equal(pool.state.calls, 0, "blocked fallback must not create a pool");
  assert.equal(pool.state.connects, 0);
});

test("expired authorization blocks the source-health fallback before any pool", async (t) => {
  const sandbox = await makeSidecarSandbox(t);
  const pool = createRecordingPoolFactory();
  const config = hostedConfig({
    authorization: authorization({ expiresAt: "2026-06-30T00:00:00.000Z" })
  });
  const result = await runBootstrapDualWrite({
    rootDir: sandbox,
    enabled: true,
    environment: {
      COLLECTOR_RUN_ID: "run-fallback-expired-authorization",
      DATABASE_URL: "postgres://user:secret@db.example:5432/neon"
    },
    clock: fixedClock(),
    log: false,
    normalizedOnlyHosted: config,
    createSourceHealthPool: pool.factory
  });

  assert.equal(result.hosted.status, "failed");
  assert.equal(result.source_health.status, "blocked");
  assert.match(result.source_health.error.message, /authorization_expired/);
  assert.equal(pool.state.calls, 0);
  assert.equal(pool.state.connects, 0);
});

test("fingerprint mismatch blocks the source-health fallback before any pool", async (t) => {
  const sandbox = await makeSidecarSandbox(t);
  const pool = createRecordingPoolFactory();
  const config = hostedConfig({
    authorization: authorization({ targetFingerprint: "b".repeat(64) })
  });
  const result = await runBootstrapDualWrite({
    rootDir: sandbox,
    enabled: true,
    environment: {
      COLLECTOR_RUN_ID: "run-fallback-fingerprint-mismatch",
      DATABASE_URL: "postgres://user:secret@db.example:5432/neon"
    },
    clock: fixedClock(),
    log: false,
    normalizedOnlyHosted: config,
    createSourceHealthPool: pool.factory
  });

  assert.equal(result.hosted.status, "failed");
  assert.equal(result.source_health.status, "blocked");
  assert.match(result.source_health.error.message, /target_fingerprint_mismatch/);
  assert.equal(pool.state.calls, 0);
  assert.equal(pool.state.connects, 0);
});

test("routing override blocks the source-health fallback before any pool", async (t) => {
  const sandbox = await makeSidecarSandbox(t);
  const pool = createRecordingPoolFactory();
  const config = hostedConfig({ r2: createFakeR2({ failPut: true }) });
  const result = await runBootstrapDualWrite({
    rootDir: sandbox,
    enabled: true,
    environment: {
      COLLECTOR_RUN_ID: "run-fallback-routing-override",
      DATABASE_URL: "postgres://user:secret@db.example:5432/neon?host=evil.example"
    },
    clock: fixedClock(),
    log: false,
    normalizedOnlyHosted: config,
    createSourceHealthPool: pool.factory
  });

  assert.equal(result.fallback.status, "written");
  assert.equal(result.hosted.status, "failed");
  assert.equal(result.source_health.status, "blocked");
  assert.match(result.source_health.error.message, /routing override/);
  assert.equal(pool.state.calls, 0, "a routing override must be rejected before pool creation");
});

test("authorized source-health fallback fails visibly when the schema is absent and never inserts", async (t) => {
  const sandbox = await makeSidecarSandbox(t);
  const pool = createRecordingPoolFactory({ schemaPresent: false });
  const databaseUrl = "postgres://user:secret@db.example:5432/neon";
  const fingerprint = calculateDatabaseFingerprint(databaseUrl);
  const config = hostedConfig({
    r2: createFakeR2({ failPut: true }),
    authorization: authorization({ targetFingerprint: fingerprint }),
    expectedTargetFingerprint: fingerprint,
    targetFingerprint: fingerprint
  });
  const result = await runBootstrapDualWrite({
    rootDir: sandbox,
    enabled: true,
    environment: {
      COLLECTOR_RUN_ID: "run-fallback-schema-absent",
      DATABASE_URL: databaseUrl
    },
    clock: fixedClock(),
    log: false,
    normalizedOnlyHosted: config,
    createSourceHealthPool: pool.factory
  });

  assert.equal(result.hosted.status, "failed");
  assert.equal(result.source_health.status, "failed");
  assert.equal(result.source_health.error.type, "source_health_schema_not_ready");
  assert.match(result.source_health.error.message, /never applies migrations/);
  assert.equal(pool.state.calls, 1);
  assert.equal(pool.state.connects, 0, "schema check happens before any transaction connect");
  assert.ok(pool.state.queries.every(({ sql }) => !/INSERT\s+INTO\s+ingestion\.source_health/i.test(sql)));
});

test("workflow exposes no legacy raw write operation and keeps the audit read-only", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const workflow = await readFile(path.join(root, ".github/workflows/collect-wait-times.yml"), "utf8");

  assert.doesNotMatch(workflow, /backfill-hosted-validation/, "the legacy raw write operation/job must be removed");
  assert.doesNotMatch(workflow, /backfill-wait-times-to-postgres/, "the workflow must not invoke the legacy raw backfill script");
  assert.doesNotMatch(workflow, /authorize-validation-only-0004/, "the workflow must never authorize 0004");
  assert.match(workflow, /audit-hosted-backfill/, "the read-only audit operation stays available");
  assert.match(workflow, /node scripts\/report-hosted-backfill\.mjs/, "the audit keeps using the read-only report command");
});

test("workflow materializes normalized-only inputs from Variables and a Secret before the sidecar", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const workflow = await readFile(path.join(root, ".github/workflows/collect-wait-times.yml"), "utf8");

  const collectJobStart = workflow.indexOf("jobs:\n  collect:");
  const auditJobStart = workflow.indexOf("  audit-target-gate:");
  assert.ok(collectJobStart !== -1 && auditJobStart > collectJobStart, "collect job section is discoverable");
  const collectJob = workflow.slice(collectJobStart, auditJobStart);

  const gitCommitIndex = collectJob.indexOf("Commit updated wait-time data");
  const prepIndex = collectJob.indexOf("Prepare normalized-only hosted inputs");
  const surfacePrepIndex = collectJob.indexOf("Surface hosted input preparation failure");
  const sidecarIndex = collectJob.indexOf("Normalized-only dual-write sidecar");
  const sidecarSurfaceIndex = collectJob.indexOf("Surface dual-write failure");
  assert.ok(gitCommitIndex !== -1 && prepIndex > gitCommitIndex, "input preparation runs after the Git fallback commit");
  assert.ok(surfacePrepIndex > prepIndex && sidecarIndex > surfacePrepIndex, "the sidecar runs after preparation and its failure surface");

  const prep = collectJob.slice(prepIndex, surfacePrepIndex);
  const sidecar = collectJob.slice(sidecarIndex, sidecarSurfaceIndex);
  const surfacePrep = collectJob.slice(surfacePrepIndex, sidecarIndex);

  // Sources are JSON Variables plus an encrypted Secret, never old *_PATH variable sources.
  assert.ok(prep.includes("vars.NORMALIZED_ONLY_REVIEWED_CATALOG_JSON"));
  assert.ok(prep.includes("vars.NORMALIZED_ONLY_ACCESS_MODE_MAPPING_JSON"));
  assert.ok(prep.includes("secrets.NORMALIZED_ONLY_AUTHORIZATION_JSON"));
  assert.doesNotMatch(
    workflow,
    /(?:vars|secrets)\.NORMALIZED_ONLY_(?:REVIEWED_CATALOG|ACCESS_MODE_MAPPING|AUTHORIZATION)_PATH/
  );

  // Only materialize for a relevant run and only when the flag is exactly true.
  assert.match(prep, /always\(\) && \(steps\.collect\.outcome == 'failure' \|\|/);
  assert.ok(prep.includes(`"$COLLECTOR_DUAL_WRITE_ENABLED" != "true"`));

  // Ephemeral RUNNER_TEMP files with restrictive permissions and safe creation flags.
  assert.ok(prep.includes('mktemp -d "$RUNNER_TEMP/normalized-only-inputs-'));
  assert.ok(prep.includes("umask 077"));
  assert.ok(prep.includes("mode: 0o600"));
  assert.ok(prep.includes('flag: "wx"'));

  // Only paths leave through GITHUB_OUTPUT; JSON contents are never written or echoed.
  const outputRedirections = prep
    .split("\n")
    .filter((line) => line.includes('"$GITHUB_OUTPUT"'));
  assert.ok(outputRedirections.length >= 2, "preparation exposes outputs for the disabled and enabled paths");
  for (const line of outputRedirections) {
    assert.doesNotMatch(line, /JSON/);
    if (line.includes("=")) assert.match(line, /_path=/);
  }
  for (const name of ["reviewed_catalog_path", "access_mode_mapping_path", "authorization_path"]) {
    assert.ok(prep.includes(`printf '${name}=%s\\n' "$${name}"`), `${name} is exposed as a path output`);
  }
  assert.doesNotMatch(prep, /(?:echo|printf)[^\n]*NORMALIZED_ONLY_[A-Z_]*_JSON/);

  // JSON validation happens inside preparation, before any sidecar/cloud access.
  assert.ok(prep.includes("JSON.parse"));
  assert.ok(prep.includes("must be a nonempty GitHub Variable or Secret"));
  assert.ok(prep.includes("must contain valid JSON"));
  assert.match(
    prep,
    /parsed === null \|\| typeof parsed !== "object" \|\| Array\.isArray\(parsed\)/,
    "array JSON must be rejected before any cloud access"
  );
  assert.ok(sidecar.includes("steps.dual_write_inputs.outcome == 'success'"));
  assert.ok(sidecar.includes(
    "NORMALIZED_ONLY_REVIEWED_CATALOG_PATH: ${{ vars.COLLECTOR_DUAL_WRITE_ENABLED == 'true' && steps.dual_write_inputs.outputs.reviewed_catalog_path || '' }}"
  ));
  assert.ok(sidecar.includes(
    "NORMALIZED_ONLY_ACCESS_MODE_MAPPING_PATH: ${{ vars.COLLECTOR_DUAL_WRITE_ENABLED == 'true' && steps.dual_write_inputs.outputs.access_mode_mapping_path || '' }}"
  ));
  assert.ok(sidecar.includes(
    "NORMALIZED_ONLY_AUTHORIZATION_PATH: ${{ vars.COLLECTOR_DUAL_WRITE_ENABLED == 'true' && steps.dual_write_inputs.outputs.authorization_path || '' }}"
  ));

  // Disabled mode materializes nothing and the sidecar receives no cloud config.
  assert.ok(prep.includes("Normalized-only dual-write is disabled; no hosted input files were materialized."));
  for (const name of [
    "DATABASE_URL",
    "RAW_ARCHIVE_BUCKET",
    "RAW_ARCHIVE_ENDPOINT",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "NORMALIZED_ONLY_REVIEWED_CATALOG_PATH",
    "NORMALIZED_ONLY_ACCESS_MODE_MAPPING_PATH",
    "NORMALIZED_ONLY_AUTHORIZATION_PATH",
    "NORMALIZED_ONLY_EXPECTED_TARGET_SHA256"
  ]) {
    assert.ok(
      sidecar.includes(`${name}: \${{ vars.COLLECTOR_DUAL_WRITE_ENABLED == 'true' &&`),
      `${name} must stay gated on the explicit opt-in`
    );
  }

  // A preparation failure is explicit, red, and preconnection; Git fallback already committed.
  assert.ok(surfacePrep.includes("failure()"));
  assert.ok(surfacePrep.includes("steps.dual_write_inputs.outcome == 'failure'"));
  assert.ok(surfacePrep.includes("before any cloud connection"));
  assert.ok(surfacePrep.includes("exit 1"));
});

function createFakeR2({ failPut = false } = {}) {
  const objects = new Map();
  const calls = [];
  return {
    calls,
    objects,
    async putObject({ bucket, key, body, metadata }) {
      calls.push({ type: "put", bucket, key });
      if (failPut) throw new Error("synthetic R2 outage");
      const id = `${bucket}/${key}`;
      if (objects.has(id)) return { created: false };
      objects.set(id, { body: Buffer.from(body), metadata: { ...metadata } });
      return { created: true };
    },
    async headObject({ bucket, key }) {
      calls.push({ type: "head", bucket, key });
      const object = objects.get(`${bucket}/${key}`);
      if (!object) throw new Error("synthetic R2 object is missing");
      return { contentLength: object.body.byteLength, metadata: { ...object.metadata } };
    }
  };
}

function createRecordingPoolFactory({ schemaPresent = true } = {}) {
  const state = { calls: 0, connects: 0, queries: [], databaseUrl: null };
  const factory = async (databaseUrl) => {
    state.calls += 1;
    state.databaseUrl = databaseUrl;
    const client = {
      async query(sql, params = []) {
        state.queries.push({ sql, params });
        return { rows: [] };
      },
      release() {}
    };
    return {
      async query(sql, params = []) {
        state.queries.push({ sql, params });
        return { rows: [{ present: schemaPresent ? "ingestion.source_health" : null }] };
      },
      async connect() {
        state.connects += 1;
        return client;
      },
      async end() {}
    };
  };
  return { state, factory };
}

function createFakeStorageDatabase({ failNormalizedInsert = false, schemaReady = true } = {}) {
  const queries = [];
  let transactionCount = 0;
  let rawInsertAttempts = 0;
  const cloneMap = (map) => new Map([...map].map(([key, value]) => [key, structuredClone(value)]));
  const cloneState = (state) => ({
    references: cloneMap(state.references),
    catalogEntries: cloneMap(state.catalogEntries),
    normalized: cloneMap(state.normalized),
    sourceHealth: cloneMap(state.sourceHealth)
  });
  let committed = {
    references: new Map(),
    catalogEntries: new Map(),
    normalized: new Map(),
    sourceHealth: new Map()
  };
  let working = null;
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      const statement = sql.trim();
      if (statement === "BEGIN") {
        transactionCount += 1;
        if (working) throw new Error("nested transaction in normalized-only fake");
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
        throw new Error("raw observation writes are forbidden");
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
        if (failNormalizedInsert) {
          throw Object.assign(new Error("synthetic normalized insert failure"), { code: "FAKE_NORMALIZED_INSERT_FAILED" });
        }
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
      throw new Error(`Unexpected normalized-only fake SQL: ${statement}`);
    },
    release() {}
  };
  const pool = { async connect() { return client; } };
  return {
    database: {
      async verifyNormalizedSchemaReady() {
        return schemaReady;
      },
      async withTransaction(operation) {
        return withPostgresStorageTransaction(pool, (client) => operation({
          archiveLines: createPostgresArchiveLineReferenceRepository(client),
          catalog: createPostgresCatalogRepository(client),
          normalized: createPostgresNormalizedObservationRepository(client),
          sourceHealth: createPostgresSourceHealthRepository(client)
        }));
      }
    },
    queries,
    get committed() { return committed; },
    get transactionCount() { return transactionCount; },
    get rawInsertAttempts() { return rawInsertAttempts; }
  };
}

async function makeSidecarSandbox(t) {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "disney-normalized-only-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const waitTimes = path.join(sandbox, "data", "wait_times");
  await mkdir(waitTimes, { recursive: true });
  await writeFile(path.join(waitTimes, "latest_snapshot.json"), JSON.stringify({
    snapshotUtc: snapshotRow.snapshot_utc,
    snapshotParkDate: snapshotRow.snapshot_park_date,
    rows: [snapshotRow]
  }));
  await writeFile(path.join(waitTimes, "wait_times_2026-07-01.csv"), "fixture");
  return sandbox;
}
