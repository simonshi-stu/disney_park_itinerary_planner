import { randomUUID } from "node:crypto";

export const dualWriteFeatureFlag = "COLLECTOR_DUAL_WRITE_ENABLED";
export const dualWriteResultVersion = "collector-dual-write-result.v1";

export class DualWriteError extends Error {
  constructor(message, result, cause) {
    super(message, { cause });
    this.name = "DualWriteError";
    this.result = result;
  }
}

export function isDualWriteEnabled(value) {
  if (typeof value === "boolean") return value;
  return String(value ?? "").trim().toLowerCase() === "true";
}

export async function runDualWrite(options = {}) {
  const {
    envelope,
    writeGitFallback,
    writeHosted,
    enabled = process.env[dualWriteFeatureFlag],
    runId = randomUUID(),
    clock = () => new Date()
  } = options;

  assertEnvelope(envelope);
  assertWriter(writeGitFallback, "writeGitFallback");
  assertNonEmptyString(runId, "runId");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  const featureEnabled = isDualWriteEnabled(enabled);
  if (featureEnabled) assertWriter(writeHosted, "writeHosted");

  const startedAt = parseInstant(clock(), "started_at");
  const deduplicationKey = envelope.payload_sha256 || envelope.envelope_id;
  const context = Object.freeze({
    envelope,
    runId,
    deduplicationKey
  });

  // Commit the existing path first so a hosted outage cannot remove the rollback path.
  try {
    await writeGitFallback(context);
  } catch (error) {
    const result = finalizeResult({
      runId,
      envelope,
      deduplicationKey,
      enabled: featureEnabled,
      startedAt,
      finishedAt: clock(),
      fallback: { status: "failed" },
      hosted: { status: "not_attempted", error: null },
      failureReason: "git_fallback_write_failed"
    });
    throw new DualWriteError(`Git fallback write failed: ${errorMessage(error)}`, result, error);
  }

  if (!featureEnabled) {
    return finalizeResult({
      runId,
      envelope,
      deduplicationKey,
      enabled: false,
      startedAt,
      finishedAt: clock(),
      fallback: { status: "written" },
      hosted: { status: "disabled", error: null }
    });
  }

  try {
    await writeHosted(context);
    return finalizeResult({
      runId,
      envelope,
      deduplicationKey,
      enabled: true,
      startedAt,
      finishedAt: clock(),
      fallback: { status: "written" },
      hosted: { status: "written", error: null }
    });
  } catch (error) {
    return finalizeResult({
      runId,
      envelope,
      deduplicationKey,
      enabled: true,
      startedAt,
      finishedAt: clock(),
      fallback: { status: "written" },
      hosted: {
        status: "failed",
        error: { type: "hosted_write_error", message: errorMessage(error) }
      }
    });
  }
}

function finalizeResult({ runId, envelope, deduplicationKey, enabled, startedAt, finishedAt, fallback, hosted, failureReason }) {
  const finished = parseInstant(finishedAt, "finished_at");
  if (finished.getTime() < startedAt.getTime()) throw new TypeError("finished_at precedes started_at");

  return deepFreeze({
    contract_version: dualWriteResultVersion,
    run_id: runId,
    envelope_id: envelope.envelope_id,
    deduplication_key: deduplicationKey,
    source_status: envelope.status,
    feature_flag: {
      name: dualWriteFeatureFlag,
      enabled
    },
    started_at: startedAt.toISOString(),
    finished_at: finished.toISOString(),
    fallback,
    hosted,
    failure_reason: failureReason || (hosted.status === "failed" ? "hosted_write_failed" : null)
  });
}

function assertEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") throw new TypeError("envelope must be an object");
  if (envelope.contract_version !== "source-envelope.v1") {
    throw new TypeError("envelope.contract_version must be source-envelope.v1");
  }
  if (!/^[a-f0-9]{64}$/.test(String(envelope.envelope_id || ""))) {
    throw new TypeError("envelope.envelope_id must be a SHA-256 hex string");
  }
  if (!['ok', 'stale', 'outage'].includes(envelope.status)) {
    throw new TypeError("envelope.status must be one of ok, stale, outage");
  }
}

function assertWriter(writer, field) {
  if (typeof writer !== "function") throw new TypeError(`${field} must be a function`);
}

function assertNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${field} must be a non-empty string`);
}

function parseInstant(value, field) {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) throw new TypeError(`invalid ${field}`);
  return instant;
}

function errorMessage(error) {
  return String(error && error.message ? error.message : error)
    .replace(/([a-z][a-z\d+.-]*:\/\/)([^/\s@]+)@/gi, "$1[redacted]@")
    .replace(/([?&](?:password|token|secret|key|access[_-]?key)\s*=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 500);
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
