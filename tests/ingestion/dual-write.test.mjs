import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DualWriteError,
  dualWriteFeatureFlag,
  dualWriteResultVersion,
  isDualWriteEnabled,
  runDualWrite
} from "../../workers/collector/dual-write.mjs";
import { parseSnapshotCsv, persistRawSnapshot, runBootstrapDualWrite, runBootstrapSourceFailure, serializeSnapshotRows, toRawRecord } from "../../workers/collector/run-dual-write.mjs";

const envelope = Object.freeze({
  contract_version: "source-envelope.v1",
  envelope_id: "a".repeat(64),
  payload_sha256: "b".repeat(64),
  status: "ok",
  payload: "snapshot"
});

const snapshotRow = {
  snapshot_utc: "2026-07-01T15:00:00.000Z",
  snapshot_park_datetime: "2026-07-01 08:00:00",
  snapshot_park_date: "2026-07-01",
  snapshot_timezone: "America/Los_Angeles",
  park_id: "disneyland",
  park_name: "Disneyland",
  land: "Test Land",
  ride_id: "ride-1",
  ride_name: "Ride, One",
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

test("feature flag is explicit and fails closed for unknown values", () => {
  assert.equal(dualWriteFeatureFlag, "COLLECTOR_DUAL_WRITE_ENABLED");
  assert.equal(isDualWriteEnabled(true), true);
  assert.equal(isDualWriteEnabled("TRUE"), true);
  assert.equal(isDualWriteEnabled(false), false);
  assert.equal(isDualWriteEnabled("yes"), false);
  assert.equal(isDualWriteEnabled(undefined), false);
});

test("disabled dual write commits Git fallback and never calls hosted storage", async () => {
  const calls = [];
  const result = await runDualWrite({
    envelope,
    enabled: false,
    runId: "run-disabled",
    clock: fixedClock(),
    writeGitFallback: async (context) => calls.push(["git", context]),
    writeHosted: async () => calls.push(["hosted"])
  });

  assert.equal(result.contract_version, dualWriteResultVersion);
  assert.equal(result.run_id, "run-disabled");
  assert.equal(result.feature_flag.enabled, false);
  assert.equal(result.fallback.status, "written");
  assert.equal(result.hosted.status, "disabled");
  assert.equal(result.failure_reason, null);
  assert.equal(result.source_status, "ok");
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(calls.map(([name]) => name), ["git"]);
  assert.equal(calls[0][1].deduplicationKey, envelope.payload_sha256);
});

test("enabled dual write writes Git before hosted storage with one deduplication key", async () => {
  const calls = [];
  const result = await runDualWrite({
    envelope,
    enabled: true,
    runId: "run-success",
    clock: fixedClock(),
    writeGitFallback: async (context) => calls.push(["git", context]),
    writeHosted: async (context) => calls.push(["hosted", context])
  });

  assert.equal(result.feature_flag.enabled, true);
  assert.equal(result.hosted.status, "written");
  assert.deepEqual(calls.map(([name]) => name), ["git", "hosted"]);
  assert.equal(calls[0][1].deduplicationKey, envelope.payload_sha256);
  assert.equal(calls[1][1].deduplicationKey, envelope.payload_sha256);
});

test("hosted failure is reported without breaking the already-written Git fallback", async () => {
  const calls = [];
  const result = await runDualWrite({
    envelope,
    enabled: true,
    runId: "run-hosted-failure",
    clock: fixedClock(),
    writeGitFallback: async () => calls.push("git"),
    writeHosted: async () => {
      calls.push("hosted");
      throw new Error("database unavailable");
    }
  });

  assert.deepEqual(calls, ["git", "hosted"]);
  assert.equal(result.fallback.status, "written");
  assert.equal(result.hosted.status, "failed");
  assert.equal(result.failure_reason, "hosted_write_failed");
  assert.deepEqual(result.hosted.error, { type: "hosted_write_error", message: "database unavailable" });
});

test("Git fallback failure stops hosted write and fails closed", async () => {
  let hostedCalls = 0;
  await assert.rejects(
    () => runDualWrite({
      envelope,
      enabled: true,
      runId: "run-git-failure",
      clock: fixedClock(),
      writeGitFallback: async () => { throw new Error("repository unavailable"); },
      writeHosted: async () => { hostedCalls += 1; }
    }),
    (error) => {
      assert.equal(error instanceof DualWriteError, true);
      assert.match(error.message, /Git fallback write failed: repository unavailable/);
      assert.equal(error.result.fallback.status, "failed");
      assert.equal(error.result.hosted.status, "not_attempted");
      assert.equal(error.result.failure_reason, "git_fallback_write_failed");
      return true;
    }
  );
  assert.equal(hostedCalls, 0);
});

test("invalid hosted configuration is rejected only when the flag is enabled", async () => {
  await assert.doesNotReject(() => runDualWrite({
    envelope,
    enabled: false,
    runId: "run-no-hosted-port",
    clock: fixedClock(),
    writeGitFallback: async () => {}
  }));
  await assert.rejects(
    () => runDualWrite({
      envelope,
      enabled: true,
      runId: "run-missing-hosted-port",
      clock: fixedClock(),
      writeGitFallback: async () => {}
    }),
    /writeHosted must be a function/
  );
});

test("the environment flag is used when enabled is omitted", async () => {
  const previous = process.env[dualWriteFeatureFlag];
  process.env[dualWriteFeatureFlag] = "true";
  const calls = [];
  try {
    const result = await runDualWrite({
      envelope,
      runId: "run-env-flag",
      clock: fixedClock(),
      writeGitFallback: async () => calls.push("git"),
      writeHosted: async () => calls.push("hosted")
    });
    assert.equal(result.feature_flag.enabled, true);
    assert.deepEqual(calls, ["git", "hosted"]);
  } finally {
    if (previous === undefined) delete process.env[dualWriteFeatureFlag];
    else process.env[dualWriteFeatureFlag] = previous;
  }
});

test("source envelope contract and status are validated", async () => {
  await assert.rejects(
    () => runDualWrite({
      envelope: { ...envelope, contract_version: "source-envelope.v2" },
      enabled: false,
      runId: "run-invalid-version",
      writeGitFallback: async () => {}
    }),
    /contract_version must be source-envelope.v1/
  );
  await assert.rejects(
    () => runDualWrite({
      envelope: { ...envelope, status: "unknown" },
      enabled: false,
      runId: "run-invalid-status",
      writeGitFallback: async () => {}
    }),
    /envelope.status must be one of ok, stale, outage/
  );
});

test("hosted payload is one immutable snapshot instead of the growing daily file", () => {
  const payload = serializeSnapshotRows([snapshotRow]);
  assert.match(payload, /^snapshot_utc,snapshot_park_datetime/);
  assert.match(payload, /"Ride, One"/);
  assert.equal(payload.trim().split("\n").length, 2);
  assert.deepEqual(parseSnapshotCsv(payload), [snapshotRow]);
});

test("bootstrap sidecar uses the latest snapshot rows and keeps hosted config failures non-blocking", async (t) => {
  const sandbox = await makeSidecarSandbox(t);
  const clock = fixedClock();
  let storedHealth = null;
  const disabled = await runBootstrapDualWrite({
    rootDir: sandbox,
    enabled: false,
    environment: {},
    clock,
    log: false,
    sourceHealthRepository: { async upsertSourceHealth(record) { storedHealth = record; } }
  });
  assert.equal(disabled.fallback.status, "written");
  assert.equal(disabled.hosted.status, "disabled");
  assert.equal(disabled.source_health.status, "written");
  assert.equal(storedHealth.source_status, "ok");
  assert.equal(storedHealth.fallback_status, "written");

  const hostedUnavailable = await runBootstrapDualWrite({
    rootDir: sandbox,
    enabled: true,
    environment: {},
    clock: fixedClock(),
    log: false
  });
  assert.equal(hostedUnavailable.fallback.status, "written");
  assert.equal(hostedUnavailable.hosted.status, "failed");
  assert.equal(hostedUnavailable.failure_reason, "hosted_write_failed");
  assert.equal(hostedUnavailable.source_health.status, "not_configured");
  assert.equal((await readFile(path.join(sandbox, "data", "wait_times", "wait_times_2026-07-01.csv"), "utf8")).length > 0, true);
});

test("collector failure records an outage without reading or writing a stale Git snapshot", async () => {
  let storedHealth = null;
  const result = await runBootstrapSourceFailure({
    environment: {
      COLLECTOR_RUN_ID: "run-source-outage",
      COLLECTOR_SOURCE_FAILURE: "queue API unavailable"
    },
    clock: fixedClock(),
    log: false,
    sourceHealthRepository: { async upsertSourceHealth(record) { storedHealth = record; } }
  });
  assert.equal(result.source_status, "outage");
  assert.equal(result.fallback.status, "not_attempted");
  assert.equal(result.hosted.status, "not_attempted");
  assert.equal(result.failure_reason, "collector_source_failed");
  assert.equal(result.source_health.status, "written");
  assert.equal(storedHealth.source_status, "outage");
  assert.equal(storedHealth.error_message, "queue API unavailable");
});

test("source-health persistence failure is visible in the sidecar result", async (t) => {
  const sandbox = await makeSidecarSandbox(t);
  const result = await runBootstrapDualWrite({
    rootDir: sandbox,
    enabled: false,
    environment: {},
    clock: fixedClock(),
    log: false,
    sourceHealthRepository: { async upsertSourceHealth() { throw new Error("health database unavailable"); } }
  });
  assert.equal(result.fallback.status, "written");
  assert.equal(result.source_health.status, "failed");
  assert.equal(result.source_health.error.type, "source_health_write_error");
});

test("Git fallback failure is persisted to source health before the sidecar fails", async (t) => {
  const sandbox = await makeSidecarSandbox(t);
  let storedHealth = null;
  await assert.rejects(
    () => runBootstrapDualWrite({
      rootDir: sandbox,
      enabled: false,
      environment: {
        COLLECTOR_RUN_ID: "run-git-fallback-failure",
        COLLECTOR_GIT_FALLBACK_OUTCOME: "failure"
      },
      clock: fixedClock(),
      log: false,
      sourceHealthRepository: { async upsertSourceHealth(record) { storedHealth = record; } }
    }),
    /Git fallback write failed/
  );

  assert.equal(storedHealth.source_status, "ok");
  assert.equal(storedHealth.fallback_status, "failed");
  assert.equal(storedHealth.hosted_write_status, "not_attempted");
});

test("raw persistence validates park dates and maps archive and observation rows", async () => {
  const queries = [];
  const client = {
    async query(text, values = []) { queries.push({ text, values }); },
    release() {}
  };
  const pool = { async connect() { return client; } };
  const payload = serializeSnapshotRows([snapshotRow]);
  const envelope = {
    payload_sha256: "c".repeat(64),
    payload,
    schema_version: "raw-wait-observation.v1"
  };

  await persistRawSnapshot({
    envelope,
    input: { content: Buffer.from(payload), sourceName: "wait_times_snapshot_test.csv" },
    objectUri: "s3://raw/wait-times/test.csv",
    pool,
    migrate: async () => {}
  });

  assert.match(queries[1].text, /INSERT INTO catalog\.parks/);
  assert.deepEqual(queries[1].values, ["disneyland", "Disneyland", "America/Los_Angeles"]);
  assert.match(queries[2].text, /INSERT INTO ingestion\.raw_archives/);
  assert.deepEqual(queries[2].values, ["c".repeat(64), "c".repeat(64), "s3://raw/wait-times/test.csv", Buffer.byteLength(payload), "wait_times_snapshot_test.csv", "raw-wait-observation.v1"]);
  assert.match(queries[3].text, /INSERT INTO ingestion\.raw_wait_observations/);
  assert.deepEqual(queries[3].values.slice(0, 17), [
    toRawRecord(snapshotRow, "c".repeat(64), 1).rawObservationId,
    "c".repeat(64),
    1,
    snapshotRow.snapshot_utc,
    snapshotRow.snapshot_park_datetime,
    snapshotRow.snapshot_park_date,
    snapshotRow.snapshot_timezone,
    snapshotRow.park_id,
    snapshotRow.park_name,
    snapshotRow.land,
    snapshotRow.ride_id,
    snapshotRow.ride_name,
    true,
    25,
    snapshotRow.source_last_updated_utc,
    snapshotRow.source_last_updated_park_datetime,
    snapshotRow.source_url
  ]);
  assert.throws(
    () => toRawRecord({ ...snapshotRow, snapshot_park_date: "2026-07-02" }, "c".repeat(64), 1),
    /inconsistent snapshot_park_date/
  );
  assert.throws(
    () => toRawRecord({ ...snapshotRow, snapshot_park_datetime: "2026-07-01 09:00:00" }, "c".repeat(64), 1),
    /inconsistent snapshot_park_datetime/
  );
  assert.throws(
    () => toRawRecord({ ...snapshotRow, wait_time_minutes: "1.5" }, "c".repeat(64), 1),
    /invalid wait_time_minutes/
  );
});

async function makeSidecarSandbox(t) {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "disney-dual-write-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const waitTimes = path.join(sandbox, "data", "wait_times");
  await mkdir(waitTimes, { recursive: true });
  await writeFile(path.join(waitTimes, "latest_snapshot.json"), JSON.stringify({
    snapshotUtc: snapshotRow.snapshot_utc,
    snapshotParkDate: snapshotRow.snapshot_park_date,
    rows: [snapshotRow]
  }));
  await writeFile(path.join(waitTimes, "wait_times_2026-07-01.csv"), serializeSnapshotRows([snapshotRow]));
  return sandbox;
}
