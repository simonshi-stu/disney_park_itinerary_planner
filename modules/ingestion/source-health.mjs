import { createHash, randomUUID } from "node:crypto";

export const sourceHealthVersion = "source-health.v1";
export const dualWriteWindowReportVersion = "dual-write-window-report.v1";

const sourceStatuses = new Set(["ok", "stale", "outage"]);
const fallbackStatuses = new Set(["written", "failed", "not_attempted"]);
const hostedStatuses = new Set(["disabled", "written", "failed", "not_attempted"]);
const sha256Pattern = /^[a-f0-9]{64}$/;

export function buildSourceHealthRecord(options = {}) {
  const {
    envelope,
    runId,
    recordCount = 0,
    dualWriteResult = null,
    fallbackStatus = dualWriteResult?.fallback?.status || "not_attempted",
    hostedWriteStatus = dualWriteResult?.hosted?.status || "not_attempted",
    hostedFailureReason = dualWriteResult?.failure_reason === "hosted_write_failed" ? "hosted_write_failed" : null,
    hostedFailureMessage = dualWriteResult?.hosted?.error?.message || null,
    clock = () => new Date()
  } = options;

  assertSourceEnvelope(envelope);
  assertNonEmptyString(runId, "runId");
  assertRecordCount(recordCount);
  assertStatus(fallbackStatus, fallbackStatuses, "fallbackStatus");
  assertStatus(hostedWriteStatus, hostedStatuses, "hostedWriteStatus");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  const generatedAt = parseInstant(clock(), "generated_at");
  const sourceError = envelope.error && typeof envelope.error === "object" ? envelope.error : null;

  return deepFreeze({
    contract_version: sourceHealthVersion,
    source_health_id: hash([sourceHealthVersion, envelope.source_name, runId].join("\u001f")),
    source_name: envelope.source_name,
    run_id: runId,
    envelope_id: envelope.envelope_id,
    source_status: envelope.status,
    requested_at: envelope.requested_at,
    observed_at: envelope.observed_at,
    source_observed_at: envelope.source_observed_at,
    ingested_at: envelope.ingested_at,
    source_age_minutes: envelope.source_age_minutes,
    payload_sha256: envelope.payload_sha256,
    payload_byte_size: envelope.payload_byte_size,
    record_count: recordCount,
    adapter_version: envelope.adapter_version,
    schema_version: envelope.schema_version,
    error_type: sourceError?.type ? String(sourceError.type) : null,
    error_message: sourceError?.message ? safeMessage(sourceError.message) : null,
    fallback_status: fallbackStatus,
    hosted_write_status: hostedWriteStatus,
    hosted_failure_reason: hostedFailureReason ? safeMessage(hostedFailureReason) : null,
    hosted_failure_message: hostedFailureMessage ? safeMessage(hostedFailureMessage) : null,
    generated_at: generatedAt.toISOString()
  });
}

export async function recordSourceHealth(options = {}) {
  const { repository } = options;
  assertRepository(repository);
  const record = buildSourceHealthRecord(options);
  await persistSourceHealthRecord({ repository, record });
  return record;
}

export async function persistSourceHealthRecord({ repository, record }) {
  assertRepository(repository);
  if (!record || record.contract_version !== sourceHealthVersion) {
    throw new TypeError("record must be a source-health.v1 record");
  }
  await repository.upsertSourceHealth(record);
  return record;
}

export function compareDualWriteWindow(options = {}) {
  const {
    windowStart,
    windowEnd,
    expectedRuns = [],
    gitRuns = [],
    hostedRuns = [],
    sourceHealthRecords = [],
    runId = randomUUID(),
    generatedAt = new Date()
  } = options;

  const start = parseInstant(windowStart, "window_start");
  const end = parseInstant(windowEnd, "window_end");
  if (end.getTime() <= start.getTime()) throw new TypeError("window_end must be after window_start");
  assertNonEmptyString(runId, "runId");

  const failures = [];
  const warnings = [];
  const expected = normalizeExpectedRuns(expectedRuns, start, end, failures);
  const git = normalizeRunSet(gitRuns, "git", start, end, failures);
  const hosted = normalizeRunSet(hostedRuns, "hosted", start, end, failures);
  const health = normalizeHealthRecords(sourceHealthRecords, start, end, failures);

  if (!expected.length) {
    failures.push({ type: "incomplete_window", reason: "expected_runs is empty" });
  }

  let matchedRunCount = 0;
  for (const expectedRun of expected) {
    const runFailures = [];
    const gitRun = git.byRunId.get(expectedRun.runId);
    const hostedRun = hosted.byRunId.get(expectedRun.runId);
    const healthRecord = health.byRunId.get(expectedRun.runId);

    if (!gitRun) runFailures.push({ type: "missing_git_run", run_id: expectedRun.runId });
    else if (gitRun.status !== "written") {
      runFailures.push({ type: "git_run_not_written", run_id: expectedRun.runId, status: gitRun.status });
    }

    if (!hostedRun) runFailures.push({ type: "missing_hosted_run", run_id: expectedRun.runId });
    else if (hostedRun.status !== "written") {
      runFailures.push({ type: "hosted_run_not_written", run_id: expectedRun.runId, status: hostedRun.status });
    }

    if (gitRun && hostedRun) {
      if (!gitRun.payloadSha256 || !hostedRun.payloadSha256) {
        runFailures.push({ type: "missing_payload_hash", run_id: expectedRun.runId });
      } else if (gitRun.payloadSha256 !== hostedRun.payloadSha256) {
        runFailures.push({
          type: "payload_hash_mismatch",
          run_id: expectedRun.runId,
          git: gitRun.payloadSha256,
          hosted: hostedRun.payloadSha256
        });
      }
      if (!Number.isInteger(gitRun.recordCount) || !Number.isInteger(hostedRun.recordCount)) {
        runFailures.push({ type: "missing_record_count", run_id: expectedRun.runId });
      } else if (gitRun.recordCount !== hostedRun.recordCount) {
        runFailures.push({
          type: "record_count_mismatch",
          run_id: expectedRun.runId,
          git: gitRun.recordCount,
          hosted: hostedRun.recordCount
        });
      }
    }

    if (healthRecord?.source_status === "outage") {
      runFailures.push({ type: "source_outage", run_id: expectedRun.runId, source_name: healthRecord.source_name });
    } else if (healthRecord?.source_status === "stale") {
      warnings.push({ type: "source_stale", run_id: expectedRun.runId, source_name: healthRecord.source_name });
    }
    if (!healthRecord) runFailures.push({ type: "missing_source_health", run_id: expectedRun.runId });

    if (healthRecord && gitRun?.status === "written" && healthRecord.fallback_status !== "written") {
      runFailures.push({
        type: "source_health_fallback_not_written",
        run_id: expectedRun.runId,
        status: healthRecord.fallback_status
      });
    }
    if (healthRecord && hostedRun?.status === "written" && healthRecord.hosted_write_status !== "written") {
      runFailures.push({
        type: "source_health_hosted_not_written",
        run_id: expectedRun.runId,
        status: healthRecord.hosted_write_status
      });
    }
    if (healthRecord && gitRun?.status === "written" && hostedRun?.status === "written") {
      if (!healthRecord.payload_sha256) {
        runFailures.push({ type: "source_health_missing_payload_hash", run_id: expectedRun.runId });
      } else {
        if (healthRecord.payload_sha256 !== gitRun.payloadSha256) {
          runFailures.push({
            type: "source_health_git_hash_mismatch",
            run_id: expectedRun.runId,
            source_health: healthRecord.payload_sha256,
            git: gitRun.payloadSha256
          });
        }
        if (healthRecord.payload_sha256 !== hostedRun.payloadSha256) {
          runFailures.push({
            type: "source_health_hosted_hash_mismatch",
            run_id: expectedRun.runId,
            source_health: healthRecord.payload_sha256,
            hosted: hostedRun.payloadSha256
          });
        }
      }
      if (healthRecord.record_count !== gitRun.recordCount || healthRecord.record_count !== hostedRun.recordCount) {
        runFailures.push({
          type: "source_health_record_count_mismatch",
          run_id: expectedRun.runId,
          source_health: healthRecord.record_count,
          git: gitRun.recordCount,
          hosted: hostedRun.recordCount
        });
      }
    }

    if (runFailures.length) failures.push(...runFailures);
    else matchedRunCount += 1;
  }

  const sourceHealthSummary = {
    record_count: health.records.length,
    outage_count: health.records.filter((record) => record.source_status === "outage").length,
    stale_count: health.records.filter((record) => record.source_status === "stale").length
  };
  const status = failures.length ? "failed" : warnings.length ? "passed_with_warnings" : "passed";

  return deepFreeze({
    contract_version: dualWriteWindowReportVersion,
    run_id: runId,
    window_start: start.toISOString(),
    window_end: end.toISOString(),
    generated_at: parseInstant(generatedAt, "generated_at").toISOString(),
    status,
    complete: expected.length > 0 && failures.length === 0,
    coverage: {
      expected_run_count: expected.length,
      git_run_count: git.records.length,
      hosted_run_count: hosted.records.length,
      matched_run_count: matchedRunCount
    },
    source_health: sourceHealthSummary,
    failures,
    warnings,
    next_steps: nextSteps(status, failures)
  });
}

function normalizeExpectedRuns(runs, start, end, failures) {
  if (!Array.isArray(runs)) throw new TypeError("expectedRuns must be an array");
  const seen = new Set();
  const normalized = [];
  for (const value of runs) {
    const runId = typeof value === "string" ? value : value?.run_id;
    if (typeof runId !== "string" || runId.trim() === "") {
      failures.push({ type: "invalid_expected_run", reason: "run_id is required" });
      continue;
    }
    if (seen.has(runId)) {
      failures.push({ type: "duplicate_expected_run", run_id: runId });
      continue;
    }
    seen.add(runId);
    const timestamp = value && typeof value === "object" ? runTimestamp(value) : null;
    if (timestamp && !insideWindow(timestamp, start, end)) {
      failures.push({ type: "expected_run_outside_window", run_id: runId });
      continue;
    }
    normalized.push({ runId });
  }
  return normalized;
}

function normalizeRunSet(runs, kind, start, end, failures) {
  if (!Array.isArray(runs)) throw new TypeError(`${kind}Runs must be an array`);
  const records = [];
  const byRunId = new Map();
  for (const value of runs) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      failures.push({ type: "invalid_run", kind, reason: "run must be an object" });
      continue;
    }
    const runId = value?.run_id;
    if (typeof runId !== "string" || runId.trim() === "") {
      failures.push({ type: "invalid_run", kind, reason: "run_id is required" });
      continue;
    }
    const timestamp = runTimestamp(value);
    if (!timestamp) {
      failures.push({ type: hasTimestamp(value, ["started_at", "observed_at", "ingested_at", "generated_at"]) ? "invalid_run_timestamp" : "missing_run_timestamp", kind, run_id: runId });
      continue;
    }
    if (!insideWindow(timestamp, start, end)) continue;
    if (byRunId.has(runId)) {
      failures.push({ type: "duplicate_run", kind, run_id: runId });
      continue;
    }
    const status = value.status || value.fallback_status || value.hosted_write_status || "unknown";
    if (![...fallbackStatuses, ...hostedStatuses].includes(status)) {
      failures.push({ type: "invalid_run_status", kind, run_id: runId, status });
    }
    validateEvidenceFields(value, kind, runId, failures);
    const record = {
      runId,
      status,
      payloadSha256: value.payload_sha256 || value.deduplication_key || null,
      recordCount: Number.isInteger(value.record_count) ? value.record_count : null
    };
    records.push(record);
    byRunId.set(runId, record);
  }
  return { records, byRunId };
}

function normalizeHealthRecords(records, start, end, failures) {
  if (!Array.isArray(records)) throw new TypeError("sourceHealthRecords must be an array");
  const byRunId = new Map();
  const inWindow = [];
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      failures.push({ type: "invalid_source_health", reason: "record must be an object" });
      continue;
    }
    const timestamp = healthTimestamp(record);
    if (!record?.run_id) {
      failures.push({ type: "invalid_source_health", reason: "run_id is required" });
      continue;
    }
    if (!timestamp) {
      failures.push({ type: hasTimestamp(record, ["ingested_at", "generated_at", "started_at", "observed_at"]) ? "invalid_source_health_timestamp" : "missing_source_health_timestamp", run_id: record.run_id });
      continue;
    }
    if (!insideWindow(timestamp, start, end)) continue;
    if (byRunId.has(record.run_id)) {
      failures.push({ type: "duplicate_source_health", run_id: record.run_id });
      continue;
    }
    validateSourceHealthRecord(record, failures);
    byRunId.set(record.run_id, record);
    inWindow.push(record);
  }
  return { records: inWindow, byRunId };
}

function runTimestamp(record) {
  const value = record?.started_at || record?.observed_at || record?.ingested_at || record?.generated_at;
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function healthTimestamp(record) {
  const value = record?.ingested_at || record?.generated_at || record?.started_at || record?.observed_at;
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function hasTimestamp(record, fields) {
  return fields.some((field) => record?.[field] !== undefined && record[field] !== null && record[field] !== "");
}

function validateEvidenceFields(value, kind, runId, failures) {
  if (value.payload_sha256 !== undefined && value.payload_sha256 !== null && value.payload_sha256 !== "" && !sha256Pattern.test(String(value.payload_sha256))) {
    failures.push({ type: "invalid_payload_hash", kind, run_id: runId });
  }
  if (value.deduplication_key !== undefined && value.deduplication_key !== null && value.deduplication_key !== "" && !sha256Pattern.test(String(value.deduplication_key))) {
    failures.push({ type: "invalid_deduplication_key", kind, run_id: runId });
  }
  if (value.record_count !== undefined && (!Number.isInteger(value.record_count) || value.record_count < 0)) {
    failures.push({ type: "invalid_record_count", kind, run_id: runId, record_count: value.record_count });
  }
}

function validateSourceHealthRecord(record, failures) {
  const runId = record.run_id;
  if (record.contract_version !== sourceHealthVersion) {
    failures.push({ type: "invalid_source_health_contract", run_id: runId });
  }
  if (!sha256Pattern.test(String(record.source_health_id || ""))) {
    failures.push({ type: "invalid_source_health_id", run_id: runId });
  }
  if (!sha256Pattern.test(String(record.envelope_id || ""))) {
    failures.push({ type: "invalid_source_health_envelope_id", run_id: runId });
  }
  if (typeof record.source_name !== "string" || record.source_name.trim() === "") {
    failures.push({ type: "invalid_source_health_source_name", run_id: runId });
  }
  if (!sourceStatuses.has(record.source_status)) {
    failures.push({ type: "invalid_source_health_status", run_id: runId, status: record.source_status });
  }
  if (!fallbackStatuses.has(record.fallback_status)) {
    failures.push({ type: "invalid_source_health_fallback_status", run_id: runId, status: record.fallback_status });
  }
  if (!hostedStatuses.has(record.hosted_write_status)) {
    failures.push({ type: "invalid_source_health_hosted_status", run_id: runId, status: record.hosted_write_status });
  }
  for (const field of ["requested_at", "ingested_at", "generated_at"]) {
    if (!isValidInstant(record[field])) failures.push({ type: "invalid_source_health_timestamp", run_id: runId, field });
  }
  if (record.observed_at !== null && record.observed_at !== undefined && !isValidInstant(record.observed_at)) {
    failures.push({ type: "invalid_source_health_timestamp", run_id: runId, field: "observed_at" });
  }
  if (record.source_observed_at !== null && record.source_observed_at !== undefined && !isValidInstant(record.source_observed_at)) {
    failures.push({ type: "invalid_source_health_timestamp", run_id: runId, field: "source_observed_at" });
  }
  if (!Number.isInteger(record.record_count) || record.record_count < 0) {
    failures.push({ type: "invalid_source_health_record_count", run_id: runId });
  }
  if (record.payload_sha256 !== null && record.payload_sha256 !== undefined && !sha256Pattern.test(String(record.payload_sha256))) {
    failures.push({ type: "invalid_source_health_payload_hash", run_id: runId });
  }
  if (record.payload_byte_size !== null && record.payload_byte_size !== undefined && (!Number.isInteger(record.payload_byte_size) || record.payload_byte_size < 0)) {
    failures.push({ type: "invalid_source_health_payload_size", run_id: runId });
  }
  if (record.source_age_minutes !== null && record.source_age_minutes !== undefined && (typeof record.source_age_minutes !== "number" || !Number.isFinite(record.source_age_minutes) || record.source_age_minutes < 0)) {
    failures.push({ type: "invalid_source_health_age", run_id: runId });
  }
  for (const field of ["adapter_version", "schema_version"]) {
    if (typeof record[field] !== "string" || record[field].trim() === "") {
      failures.push({ type: "invalid_source_health_field", run_id: runId, field });
    }
  }
}

function isValidInstant(value) {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

function insideWindow(value, start, end) {
  return value.getTime() >= start.getTime() && value.getTime() <= end.getTime();
}

function nextSteps(status, failures) {
  if (status === "passed") return ["Retain the report and input snapshot as the accepted dual-write checkpoint."];
  if (status === "passed_with_warnings") return ["Investigate stale source records before using the window as a freshness checkpoint."];
  return failures.some((failure) => failure.type === "missing_hosted_run")
    ? ["Keep Git fallback enabled, repair hosted persistence, and rerun the complete window."]
    : ["Resolve every listed comparison failure and rerun the complete window before cutover."];
}

function assertSourceEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") throw new TypeError("envelope must be an object");
  if (envelope.contract_version !== "source-envelope.v1") throw new TypeError("envelope.contract_version must be source-envelope.v1");
  if (!/^[a-f0-9]{64}$/.test(String(envelope.envelope_id || ""))) throw new TypeError("envelope.envelope_id must be a SHA-256 hex string");
  if (!sourceStatuses.has(envelope.status)) throw new TypeError("envelope.status must be one of ok, stale, outage");
  for (const field of ["source_name", "adapter_version", "schema_version", "requested_at", "ingested_at"]) {
    assertNonEmptyString(envelope[field], `envelope.${field}`);
  }
}

function assertRepository(repository) {
  if (!repository || typeof repository.upsertSourceHealth !== "function") {
    throw new TypeError("repository must expose upsertSourceHealth()");
  }
}

function assertRecordCount(value) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError("recordCount must be a non-negative integer");
}

function assertStatus(value, values, field) {
  if (!values.has(value)) throw new TypeError(`${field} is invalid`);
}

function assertNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${field} must be a non-empty string`);
}

function parseInstant(value, field) {
  const instant = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(instant.getTime())) throw new TypeError(`invalid ${field}`);
  return instant;
}

function safeMessage(value) {
  return String(value)
    .replace(/([a-z][a-z\d+.-]*:\/\/)([^/\s@]+)@/gi, "$1[redacted]@")
    .replace(/([?&](?:password|token|secret|key|access[_-]?key)\s*=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 500);
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
