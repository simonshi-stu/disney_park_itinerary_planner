import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ingestSourceSnapshot, sourceEnvelopeVersion } from "../../modules/ingestion/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const payloadFixture = "snapshot_utc,ride_name\n2026-07-01T15:00:00.000Z,Example Ride\n";
const fixedClock = () => new Date("2026-07-01T15:05:00.000Z");

function fakeAdapter(overrides = {}) {
  return {
    version: "queue-times-adapter.v1",
    schemaVersion: "raw-wait-observation.v1",
    sourceUrl: "fixture://queue-times",
    attribution: "Queue-Times",
    fetchSnapshot: async () => ({ payload: payloadFixture, observedAt: "2026-07-01T15:00:00.000Z" }),
    ...overrides
  };
}

test("source envelope records source, times, payload hash, versions and attribution", async () => {
  const envelope = await ingestSourceSnapshot({
    sourceName: "queue-times",
    adapter: fakeAdapter(),
    clock: fixedClock
  });
  assert.equal(envelope.contract_version, sourceEnvelopeVersion);
  assert.equal(envelope.status, "ok");
  assert.equal(envelope.source_name, "queue-times");
  assert.equal(envelope.adapter_version, "queue-times-adapter.v1");
  assert.equal(envelope.schema_version, "raw-wait-observation.v1");
  assert.equal(envelope.requested_at, "2026-07-01T15:05:00.000Z");
  assert.equal(envelope.observed_at, "2026-07-01T15:00:00.000Z");
  assert.equal(envelope.source_observed_at, null);
  assert.equal(envelope.ingested_at, "2026-07-01T15:05:00.000Z");
  assert.equal(envelope.source_age_minutes, 5);
  assert.equal(envelope.payload_sha256, createHash("sha256").update(payloadFixture).digest("hex"));
  assert.equal(envelope.payload_byte_size, Buffer.byteLength(payloadFixture, "utf8"));
  assert.equal(envelope.source_url, "fixture://queue-times");
  assert.equal(envelope.attribution, "Queue-Times");
  assert.equal(envelope.payload, payloadFixture);
  assert.equal(envelope.error, null);
});

test("adapter outage is an explicit outage state instead of an empty success", async () => {
  const failed = await ingestSourceSnapshot({
    sourceName: "queue-times",
    adapter: fakeAdapter({
      fetchSnapshot: async () => {
        throw new Error("upstream responded 503");
      }
    }),
    clock: fixedClock
  });
  assert.equal(failed.status, "outage");
  assert.equal(failed.payload, null);
  assert.equal(failed.payload_sha256, null);
  assert.equal(failed.observed_at, null);
  assert.deepEqual(failed.error, { type: "adapter_error", message: "upstream responded 503" });
  assert.equal(failed.requested_at, "2026-07-01T15:05:00.000Z");
  assert.equal(failed.ingested_at, "2026-07-01T15:05:00.000Z");
  assert.equal(failed.attribution, "Queue-Times");

  const emptyPayload = await ingestSourceSnapshot({
    sourceName: "queue-times",
    adapter: fakeAdapter({ fetchSnapshot: async () => ({ payload: "", observedAt: "2026-07-01T15:00:00.000Z" }) }),
    clock: fixedClock
  });
  assert.equal(emptyPayload.status, "outage");
  assert.equal(emptyPayload.error.type, "empty_payload");

  const emptyResponse = await ingestSourceSnapshot({
    sourceName: "queue-times",
    adapter: fakeAdapter({ fetchSnapshot: async () => null }),
    clock: fixedClock
  });
  assert.equal(emptyResponse.status, "outage");
  assert.equal(emptyResponse.error.type, "empty_response");
});

test("stale source snapshots are explicit, keep the payload, and use source_observed_at when provided", async () => {
  const staleBySourceTime = await ingestSourceSnapshot({
    sourceName: "queue-times",
    adapter: fakeAdapter({
      fetchSnapshot: async () => ({
        payload: payloadFixture,
        observedAt: "2026-07-01T15:04:00.000Z",
        sourceObservedAt: "2026-07-01T14:00:00.000Z"
      })
    }),
    clock: fixedClock,
    staleAfterMinutes: 60
  });
  assert.equal(staleBySourceTime.status, "stale");
  assert.equal(staleBySourceTime.source_observed_at, "2026-07-01T14:00:00.000Z");
  assert.equal(staleBySourceTime.observed_at, "2026-07-01T15:04:00.000Z");
  assert.equal(staleBySourceTime.source_age_minutes, 65);
  assert.equal(staleBySourceTime.payload, payloadFixture);
  assert.equal(typeof staleBySourceTime.payload_sha256, "string");
});

test("ingested envelopes are immutable raw evidence", async () => {
  const envelope = await ingestSourceSnapshot({
    sourceName: "queue-times",
    adapter: fakeAdapter(),
    clock: fixedClock
  });
  assert.ok(Object.isFrozen(envelope));
  assert.throws(() => {
    envelope.status = "outage";
  }, TypeError);

  const outage = await ingestSourceSnapshot({
    sourceName: "queue-times",
    adapter: fakeAdapter({
      fetchSnapshot: async () => {
        throw new Error("upstream responded 503");
      }
    }),
    clock: fixedClock
  });
  assert.throws(() => {
    outage.error.type = "empty_payload";
  }, TypeError);
});

test("envelope identity is deterministic and ingestion never resolves canonical identity", async () => {
  const first = await ingestSourceSnapshot({ sourceName: "queue-times", adapter: fakeAdapter(), clock: fixedClock });
  const second = await ingestSourceSnapshot({ sourceName: "queue-times", adapter: fakeAdapter(), clock: fixedClock });
  assert.match(first.envelope_id, /^[a-f0-9]{64}$/);
  assert.equal(first.envelope_id, second.envelope_id);

  const changedPayload = await ingestSourceSnapshot({
    sourceName: "queue-times",
    adapter: fakeAdapter({
      fetchSnapshot: async () => ({
        payload: `${payloadFixture}2026-07-01T15:00:00.000Z,Second Ride\n`,
        observedAt: "2026-07-01T15:00:00.000Z"
      })
    }),
    clock: fixedClock
  });
  assert.notEqual(changedPayload.envelope_id, first.envelope_id);
  assert.equal(JSON.stringify(first).includes("canonical"), false);
});

test("misconfigured adapters and clocks fail closed", async () => {
  await assert.rejects(() => ingestSourceSnapshot({ sourceName: "", adapter: fakeAdapter() }), TypeError);
  await assert.rejects(
    () => ingestSourceSnapshot({ sourceName: "queue-times", adapter: { fetchSnapshot: async () => ({}) } }),
    TypeError
  );
  await assert.rejects(
    () => ingestSourceSnapshot({ sourceName: "queue-times", adapter: fakeAdapter(), clock: () => "not-a-date" }),
    TypeError
  );
  await assert.rejects(
    () =>
      ingestSourceSnapshot({
        sourceName: "queue-times",
        adapter: fakeAdapter({ fetchSnapshot: async () => "raw-string" }),
        clock: fixedClock
      }),
    TypeError
  );
});

test("third-party API access stays inside injected adapters", async () => {
  const source = await readFile(path.join(root, "modules/ingestion/index.mjs"), "utf8");
  assert.doesNotMatch(source, /node:https?/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /from\s+"\.\.\//);
});
