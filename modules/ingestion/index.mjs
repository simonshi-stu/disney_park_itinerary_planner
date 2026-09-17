import { createHash } from "node:crypto";

export const sourceEnvelopeVersion = "source-envelope.v1";

export async function ingestSourceSnapshot(options = {}) {
  const { sourceName, adapter, clock = () => new Date(), staleAfterMinutes = 60 } = options;

  assertNonEmptyString(sourceName, "sourceName");
  assertAdapter(adapter);
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  if (!Number.isFinite(staleAfterMinutes) || staleAfterMinutes < 0) {
    throw new TypeError("staleAfterMinutes must be a non-negative number");
  }

  const requestedAt = parseInstant(clock(), "requested_at");
  let snapshot = null;
  let failure = null;
  try {
    snapshot = await adapter.fetchSnapshot({ requestedAt: requestedAt.toISOString() });
  } catch (error) {
    failure = { type: "adapter_error", message: errorMessage(error) };
  }
  const ingestedAt = parseInstant(clock(), "ingested_at");
  if (ingestedAt.getTime() < requestedAt.getTime()) throw new TypeError("ingested_at precedes requested_at");

  if (!failure) {
    if (snapshot === null || snapshot === undefined) {
      failure = { type: "empty_response", message: "adapter returned no snapshot" };
    } else if (typeof snapshot !== "object") {
      throw new TypeError("adapter.fetchSnapshot must resolve to an object");
    } else if (String(snapshot.payload ?? "") === "") {
      failure = { type: "empty_payload", message: "adapter returned an empty payload" };
    }
  }

  if (failure) {
    return deepFreeze({
      contract_version: sourceEnvelopeVersion,
      envelope_id: buildEnvelopeId({
        sourceName,
        adapter,
        requestedAt,
        observedAt: null,
        payloadSha256: null,
        status: "outage"
      }),
      source_name: sourceName,
      adapter_version: adapter.version,
      schema_version: adapter.schemaVersion,
      status: "outage",
      requested_at: requestedAt.toISOString(),
      observed_at: null,
      source_observed_at: null,
      ingested_at: ingestedAt.toISOString(),
      source_age_minutes: null,
      payload_sha256: null,
      payload_byte_size: null,
      source_url: adapter.sourceUrl,
      attribution: adapter.attribution,
      payload: null,
      error: failure
    });
  }

  const payload = String(snapshot.payload);
  const observedAt = parseInstant(snapshot.observedAt, "observed_at");
  const sourceObservedAt =
    snapshot.sourceObservedAt === undefined || snapshot.sourceObservedAt === null || snapshot.sourceObservedAt === ""
      ? null
      : parseInstant(snapshot.sourceObservedAt, "source_observed_at");
  const stalenessBasis = sourceObservedAt || observedAt;
  const sourceAgeMinutes = round(Math.max(0, (ingestedAt.getTime() - stalenessBasis.getTime()) / 60_000), 3);
  const payloadSha256 = hashString(payload);
  const status = sourceAgeMinutes > staleAfterMinutes ? "stale" : "ok";

  return deepFreeze({
    contract_version: sourceEnvelopeVersion,
    envelope_id: buildEnvelopeId({ sourceName, adapter, requestedAt, observedAt, payloadSha256, status }),
    source_name: sourceName,
    adapter_version: adapter.version,
    schema_version: adapter.schemaVersion,
    status,
    requested_at: requestedAt.toISOString(),
    observed_at: observedAt.toISOString(),
    source_observed_at: sourceObservedAt ? sourceObservedAt.toISOString() : null,
    ingested_at: ingestedAt.toISOString(),
    source_age_minutes: sourceAgeMinutes,
    payload_sha256: payloadSha256,
    payload_byte_size: Buffer.byteLength(payload, "utf8"),
    source_url: String(snapshot.sourceUrl || adapter.sourceUrl),
    attribution: adapter.attribution,
    payload,
    error: null
  });
}

function buildEnvelopeId({ sourceName, adapter, requestedAt, observedAt, payloadSha256, status }) {
  return hashString(
    [
      sourceEnvelopeVersion,
      sourceName,
      adapter.version,
      adapter.schemaVersion,
      requestedAt.toISOString(),
      observedAt ? observedAt.toISOString() : "",
      payloadSha256 || "",
      status
    ].join("\u001f")
  );
}

function assertAdapter(adapter) {
  if (!adapter || typeof adapter.fetchSnapshot !== "function") {
    throw new TypeError("adapter must expose fetchSnapshot()");
  }
  assertNonEmptyString(adapter.version, "adapter.version");
  assertNonEmptyString(adapter.schemaVersion, "adapter.schemaVersion");
  assertNonEmptyString(adapter.sourceUrl, "adapter.sourceUrl");
  assertNonEmptyString(adapter.attribution, "adapter.attribution");
}

function assertNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function parseInstant(value, field) {
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) throw new TypeError(`invalid ${field}`);
  return instant;
}

function hashString(value) {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error) {
  return String(error && error.message ? error.message : error);
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
