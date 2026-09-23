import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPostgresSourceHealthRepository } from "../../infra/source-health-postgres.mjs";
import { reportDualWriteWindow } from "../../infra/report-dual-write-window.mjs";
import {
  buildSourceHealthRecord,
  compareDualWriteWindow,
  persistSourceHealthRecord,
  recordSourceHealth,
  sourceHealthVersion
} from "../../modules/ingestion/source-health.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const payloadHash = "a".repeat(64);
const envelope = Object.freeze({
  contract_version: "source-envelope.v1",
  envelope_id: "b".repeat(64),
  source_name: "queue-times",
  adapter_version: "queue-times-adapter.v1",
  schema_version: "raw-wait-observation.v1",
  status: "ok",
  requested_at: "2026-07-01T15:00:00.000Z",
  observed_at: "2026-07-01T14:59:00.000Z",
  source_observed_at: null,
  ingested_at: "2026-07-01T15:01:00.000Z",
  source_age_minutes: 2,
  payload_sha256: payloadHash,
  payload_byte_size: 128,
  error: null
});

const fixedClock = () => new Date("2026-07-01T15:02:00.000Z");

test("source-health contract and migration are versioned and additive", async () => {
  const schema = JSON.parse(await readFile(path.join(root, "packages/contracts/schemas/v1/source-health.schema.json"), "utf8"));
  const reportSchema = JSON.parse(await readFile(path.join(root, "packages/contracts/schemas/v1/dual-write-window-report.schema.json"), "utf8"));
  const migration = await readFile(path.join(root, "infra/migrations/0003_source_health.sql"), "utf8");
  assert.equal(schema.properties.contract_version.const, sourceHealthVersion);
  assert.ok(schema.required.includes("hosted_write_status"));
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ingestion\.source_health/);
  assert.match(migration, /UNIQUE \(source_name, run_id\)/);
  assert.doesNotMatch(migration, /DROP TABLE|ALTER TABLE .* DROP/i);

  const record = buildSourceHealthRecord({ envelope, runId: "schema-run", recordCount: 2, clock: fixedClock });
  assertSchemaConformance(record, schema);
  const report = compareDualWriteWindow({
    runId: "schema-report",
    windowStart: "2026-07-01T14:59:00.000Z",
    windowEnd: "2026-07-01T15:16:00.000Z",
    expectedRuns: [{ run_id: "schema-run", observed_at: "2026-07-01T15:00:00.000Z" }],
    gitRuns: [{ run_id: "schema-run", status: "written", payload_sha256: payloadHash, record_count: 2, observed_at: "2026-07-01T15:00:00.000Z" }],
    hostedRuns: [{ run_id: "schema-run", status: "written", payload_sha256: payloadHash, record_count: 2, observed_at: "2026-07-01T15:00:00.000Z" }],
    sourceHealthRecords: [record]
  });
  assertSchemaConformance(report, reportSchema);
});

test("source health preserves outage evidence and is updated through an injected repository", async () => {
  const outageEnvelope = {
    ...envelope,
    status: "outage",
    observed_at: null,
    source_age_minutes: null,
    payload_sha256: null,
    payload_byte_size: null,
    error: { type: "adapter_error", message: "upstream returned 503" }
  };
  let stored = null;
  const repository = {
    async upsertSourceHealth(record) {
      stored = record;
    }
  };
  const record = await recordSourceHealth({
    envelope: outageEnvelope,
    runId: "run-outage",
    recordCount: 0,
    fallbackStatus: "written",
    hostedWriteStatus: "failed",
    hostedFailureReason: "hosted_write_failed",
    clock: fixedClock,
    repository
  });

  assert.equal(record.contract_version, sourceHealthVersion);
  assert.equal(record.source_status, "outage");
  assert.equal(record.error_type, "adapter_error");
  assert.equal(record.record_count, 0);
  assert.equal(record.hosted_write_status, "failed");
  assert.equal(record.hosted_failure_message, null);
  assert.equal(record.fallback_status, "written");
  assert.equal(record.payload_sha256, null);
  assert.equal(stored.source_health_id, record.source_health_id);
  assert.equal(Object.isFrozen(record), true);
});

test("source health persistence rejects a repository failure instead of fabricating success", async () => {
  await assert.rejects(
    () => persistSourceHealthRecord({
      record: buildSourceHealthRecord({ envelope, runId: "run-failure", clock: fixedClock }),
      repository: { upsertSourceHealth: async () => { throw new Error("database unavailable"); } }
    }),
    /database unavailable/
  );
});

test("PostgreSQL source-health adapter uses an upsert keyed by source and run", async () => {
  const calls = [];
  const repository = createPostgresSourceHealthRepository({
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    }
  });
  const record = buildSourceHealthRecord({ envelope, runId: "run-upsert", clock: fixedClock });
  await repository.upsertSourceHealth(record);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO ingestion\.source_health/);
  assert.match(calls[0].sql, /ON CONFLICT \(source_name, run_id\) DO UPDATE/);
  assert.equal(calls[0].params[0], record.source_health_id);
  assert.equal(calls[0].params.length, 23);
});

test("dual-write window report passes only when expected Git and hosted runs match", () => {
  const expectedRuns = [
    { run_id: "run-1", observed_at: "2026-07-01T15:00:00.000Z" },
    { run_id: "run-2", observed_at: "2026-07-01T15:15:00.000Z" }
  ];
  const gitRuns = expectedRuns.map((run) => ({ ...run, status: "written", payload_sha256: payloadHash, record_count: 2 }));
  const hostedRuns = expectedRuns.map((run) => ({ ...run, status: "written", payload_sha256: payloadHash, record_count: 2 }));
  const report = compareDualWriteWindow({
    runId: "window-report-1",
    windowStart: "2026-07-01T14:59:00.000Z",
    windowEnd: "2026-07-01T15:16:00.000Z",
    expectedRuns,
    gitRuns,
    hostedRuns,
    sourceHealthRecords: expectedRuns.map((run) => buildSourceHealthRecord({ envelope, runId: run.run_id, recordCount: 2, dualWriteResult: {
      fallback: { status: "written" },
      hosted: { status: "written" }
    }, clock: fixedClock }))
  });

  assert.equal(report.status, "passed");
  assert.equal(report.complete, true);
  assert.equal(report.coverage.matched_run_count, 2);
  assert.deepEqual(report.failures, []);
});

test("dual-write window report excludes a missing or mismatched hosted run", () => {
  const report = compareDualWriteWindow({
    runId: "window-report-2",
    windowStart: "2026-07-01T14:59:00.000Z",
    windowEnd: "2026-07-01T15:16:00.000Z",
    expectedRuns: [{ run_id: "run-1", observed_at: "2026-07-01T15:00:00.000Z" }, { run_id: "run-2" }],
    gitRuns: [{ run_id: "run-1", observed_at: "2026-07-01T15:00:00.000Z", status: "written", payload_sha256: payloadHash, record_count: 2 }, { run_id: "run-2", observed_at: "2026-07-01T15:15:00.000Z", status: "written", payload_sha256: payloadHash, record_count: 2 }],
    hostedRuns: [{ run_id: "run-1", observed_at: "2026-07-01T15:00:00.000Z", status: "written", payload_sha256: "c".repeat(64), record_count: 1 }],
    sourceHealthRecords: [{ ...buildSourceHealthRecord({ envelope, runId: "run-1", clock: fixedClock }), source_status: "stale", ingested_at: "2026-07-01T15:01:00.000Z" }]
  });

  assert.equal(report.status, "failed");
  assert.equal(report.complete, false);
  assert.ok(report.failures.some((failure) => failure.type === "payload_hash_mismatch"));
  assert.ok(report.failures.some((failure) => failure.type === "record_count_mismatch"));
  assert.ok(report.failures.some((failure) => failure.type === "missing_hosted_run"));
});

test("dual-write window report fails when source-health evidence is missing", () => {
  const report = compareDualWriteWindow({
    runId: "window-report-no-health",
    windowStart: "2026-07-01T14:59:00.000Z",
    windowEnd: "2026-07-01T15:01:00.000Z",
    expectedRuns: [{ run_id: "run-1", observed_at: "2026-07-01T15:00:00.000Z" }],
    gitRuns: [{ run_id: "run-1", observed_at: "2026-07-01T15:00:00.000Z", status: "written", payload_sha256: payloadHash, record_count: 1 }],
    hostedRuns: [{ run_id: "run-1", observed_at: "2026-07-01T15:00:00.000Z", status: "written", payload_sha256: payloadHash, record_count: 1 }],
    sourceHealthRecords: []
  });
  assert.equal(report.status, "failed");
  assert.equal(report.complete, false);
  assert.ok(report.failures.some((failure) => failure.type === "missing_source_health"));
});

test("dual-write window report fails when payload hashes or record counts are absent", () => {
  const report = compareDualWriteWindow({
    runId: "window-report-incomplete-evidence",
    windowStart: "2026-07-01T14:59:00.000Z",
    windowEnd: "2026-07-01T15:01:00.000Z",
    expectedRuns: [{ run_id: "run-1", observed_at: "2026-07-01T15:00:00.000Z" }],
    gitRuns: [{ run_id: "run-1", observed_at: "2026-07-01T15:00:00.000Z", status: "written" }],
    hostedRuns: [{ run_id: "run-1", observed_at: "2026-07-01T15:00:00.000Z", status: "written" }],
    sourceHealthRecords: [buildSourceHealthRecord({ envelope, runId: "run-1", recordCount: 1, clock: fixedClock })]
  });
  assert.equal(report.status, "failed");
  assert.ok(report.failures.some((failure) => failure.type === "missing_payload_hash"));
  assert.ok(report.failures.some((failure) => failure.type === "missing_record_count"));
});

test("empty validation windows fail closed instead of producing a false pass", () => {
  const report = compareDualWriteWindow({
    runId: "window-report-empty",
    windowStart: "2026-07-01T15:00:00.000Z",
    windowEnd: "2026-07-01T15:15:00.000Z"
  });
  assert.equal(report.status, "failed");
  assert.equal(report.complete, false);
  assert.ok(report.failures.some((failure) => failure.type === "incomplete_window"));
});

test("read-only report entrypoint emits the versioned machine-readable result", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dual-write-window-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inputPath = path.join(directory, "input.json");
  await writeFile(inputPath, JSON.stringify({
    runId: "cli-report-1",
    windowStart: "2026-07-01T14:59:00.000Z",
    windowEnd: "2026-07-01T15:01:00.000Z",
    expectedRuns: [{ run_id: "run-1", observed_at: "2026-07-01T15:00:00.000Z" }],
    gitRuns: [{ run_id: "run-1", observed_at: "2026-07-01T15:00:00.000Z", status: "written", payload_sha256: payloadHash, record_count: 1 }],
    hostedRuns: [{ run_id: "run-1", observed_at: "2026-07-01T15:00:00.000Z", status: "written", payload_sha256: payloadHash, record_count: 1 }],
    sourceHealthRecords: [buildSourceHealthRecord({ envelope, runId: "run-1", recordCount: 1, clock: fixedClock })]
  }), "utf8");

  const report = await reportDualWriteWindow(inputPath);
  assert.equal(report.contract_version, "dual-write-window-report.v1");
  assert.equal(report.status, "passed");
  assert.equal(report.run_id, "cli-report-1");
});

function assertSchemaConformance(value, schema, location = "$") {
  if (schema.const !== undefined) assert.deepEqual(value, schema.const, `${location} must equal schema const`);
  if (schema.enum) assert.ok(schema.enum.includes(value), `${location} must match schema enum`);

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    assert.ok(types.some((type) => matchesSchemaType(value, type)), `${location} has an invalid schema type`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined) assert.ok(value.length >= schema.minLength, `${location} is shorter than schema minLength`);
    if (schema.pattern) assert.match(value, new RegExp(schema.pattern), `${location} does not match schema pattern`);
    if (schema.format === "date-time") assert.ok(!Number.isNaN(new Date(value).getTime()), `${location} is not a date-time`);
  }
  if (typeof value === "number" && schema.minimum !== undefined) assert.ok(value >= schema.minimum, `${location} is below schema minimum`);
  if (Array.isArray(value) && schema.items) value.forEach((item, index) => assertSchemaConformance(item, schema.items, `${location}[${index}]`));
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const required of schema.required || []) assert.ok(Object.hasOwn(value, required), `${location}.${required} is required`);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) assert.ok(schema.properties?.[key], `${location}.${key} is not in schema properties`);
    }
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, key)) assertSchemaConformance(value[key], childSchema, `${location}.${key}`, schema);
    }
  }
}

function matchesSchemaType(value, type) {
  if (type === "null") return value === null;
  if (type === "string") return typeof value === "string";
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  return false;
}
