import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeArchivedWaitObservation } from "../../modules/observations/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const archiveBytes = Buffer.from(
  "snapshot_utc,ride_id\n2026-09-24T17:15:00.000Z,soarin-1\n2026-09-24T17:30:00.000Z,soarin-2\n2026-09-24T17:45:00.000Z,soarin-3\n",
  "utf8"
);
const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");

test("archive normalization emits v2 with independently checked lineage, UTC, and structured access mode", async () => {
  const schema = JSON.parse(await readFile(
    path.join(root, "packages/contracts/schemas/v2/normalized-wait-observation.schema.json"),
    "utf8"
  ));
  const options = {
    rawObservation: rawObservation({ ordinal: 1, rideName: "Soarin' Across America Single Rider" }),
    archiveLineReference: lineReference(1),
    catalogEntries,
    accessMode: "single_rider",
    generatedAt: "2026-09-24T18:00:00.000Z"
  };
  const normalized = normalizeArchivedWaitObservation(options);
  const expectedRawId = createHash("sha256").update(`${archiveSha256}:1`, "utf8").digest("hex");

  assert.equal(normalized.contract_version, schema.properties.contract_version.const);
  for (const field of schema.required) assert.ok(Object.hasOwn(normalized, field), `${field} is required by v2`);
  for (const field of Object.keys(normalized)) assert.ok(schema.properties[field], `${field} must belong to v2`);
  assert.equal(normalized.raw_observation_id, expectedRawId);
  assert.equal(options.archiveLineReference.raw_observation_id, expectedRawId);
  assert.equal(normalized.park_timezone, "America/Los_Angeles");
  assert.equal(normalized.observed_at_utc, "2026-09-24T17:15:00.000Z");
  assert.equal(normalized.generated_at, "2026-09-24T18:00:00.000Z");
  assert.equal(normalized.access_mode, "single_rider");
  assert.equal(normalized.training_eligibility, "review_required");
  assert.deepEqual(normalized, normalizeArchivedWaitObservation(options));
});

test("archive normalization keeps closed-null, open-missing, and open-zero semantics", () => {
  const missing = normalize({ ordinal: 1, isOpen: true, wait: null });
  assert.equal(missing.observed_wait_time_minutes, null);
  assert.ok(missing.quality_flags.includes("missing_wait"));

  const closedZero = normalize({ ordinal: 2, isOpen: false, wait: 0 });
  assert.equal(closedZero.observed_wait_time_minutes, null);
  assert.ok(closedZero.quality_flags.includes("closed"));
  assert.ok(!closedZero.quality_flags.includes("open_zero"));

  const openZero = normalize({ ordinal: 3, isOpen: true, wait: 0 });
  assert.equal(openZero.observed_wait_time_minutes, 0);
  assert.ok(openZero.quality_flags.includes("open_zero"));
});

test("standby eligibility requires an operating lifecycle, a fresh wait, and standby mode", () => {
  const operatingCatalog = [catalogEntryWithLifecycle({
    operational_state: "operating",
    wait_capability: "posted_standby",
    training_disposition: "eligible",
    planning_disposition: "eligible"
  })];
  const eligible = normalize({ ordinal: 1, catalogEntries: operatingCatalog });
  assert.equal(eligible.training_eligibility, "standby_wait_model");
  assert.ok(!eligible.quality_flags.includes("catalog_review_required"));

  const stale = normalize({
    ordinal: 2,
    catalogEntries: operatingCatalog,
    sourceUpdatedUtc: "2026-09-24T15:00:00.000Z"
  });
  assert.equal(stale.training_eligibility, "exclude_stale_source");
  assert.ok(stale.quality_flags.includes("stale_source"));

  const nonStandby = normalize({
    ordinal: 3,
    rideName: "Soarin' Across America Single Rider",
    catalogEntries: operatingCatalog,
    accessMode: "single_rider"
  });
  assert.equal(nonStandby.access_mode, "single_rider");
  assert.equal(nonStandby.training_eligibility, "exclude_non_standby_access_mode");

  const refurbishmentCatalog = [catalogEntryWithLifecycle({
    operational_state: "refurbishment",
    wait_capability: "posted_standby",
    training_disposition: "ineligible_lifecycle",
    planning_disposition: "ineligible_lifecycle"
  })];
  const refurbishment = normalize({ ordinal: 1, catalogEntries: refurbishmentCatalog });
  assert.equal(refurbishment.training_eligibility, "ineligible_lifecycle");
  assert.ok(refurbishment.quality_flags.includes("lifecycle_ineligible"));
});

test("access-mode corrections require a new transformation version for an immutable normalized key", () => {
  const raw = rawObservation({ ordinal: 1 });
  const reference = lineReference(1);
  const input = {
    rawObservation: raw,
    archiveLineReference: reference,
    catalogEntries,
    generatedAt: "2026-09-24T18:00:00.000Z"
  };
  const original = normalizeArchivedWaitObservation({ ...input, accessMode: "standby" });
  const generatedAtRetry = normalizeArchivedWaitObservation({
    ...input,
    generatedAt: "2026-09-25T18:00:00.000Z",
    accessMode: "standby"
  });
  const correction = normalizeArchivedWaitObservation({ ...input, accessMode: "single_rider" });

  assert.equal(original.raw_observation_id, generatedAtRetry.raw_observation_id);
  assert.equal(original.transformation_version, generatedAtRetry.transformation_version);
  assert.equal(original.normalized_observation_id, generatedAtRetry.normalized_observation_id);
  assert.notEqual(original.generated_at, generatedAtRetry.generated_at);
  assert.deepEqual(withoutGeneratedAt(original), withoutGeneratedAt(generatedAtRetry));

  assert.equal(original.raw_observation_id, correction.raw_observation_id);
  assert.equal(original.transformation_version, correction.transformation_version);
  assert.equal(original.normalized_observation_id, correction.normalized_observation_id);
  assert.notEqual(original.access_mode, correction.access_mode);
  assert.notDeepEqual(withoutGeneratedAt(original), withoutGeneratedAt(correction));

  const changedStalenessPolicy = normalizeArchivedWaitObservation({
    ...input,
    accessMode: "standby",
    staleAfterMinutes: 0
  });
  assert.equal(original.normalized_observation_id, changedStalenessPolicy.normalized_observation_id);
  assert.ok(changedStalenessPolicy.quality_flags.includes("stale_source"));
  assert.notDeepEqual(withoutGeneratedAt(original), withoutGeneratedAt(changedStalenessPolicy));

  const changedCatalog = normalizeArchivedWaitObservation({
    ...input,
    accessMode: "standby",
    catalogEntries: [catalogEntryWithLifecycle({
      operational_state: "operating",
      wait_capability: "posted_standby",
      training_disposition: "eligible",
      planning_disposition: "eligible"
    })]
  });
  assert.equal(original.normalized_observation_id, changedCatalog.normalized_observation_id);
  assert.notDeepEqual(withoutGeneratedAt(original), withoutGeneratedAt(changedCatalog));

  const versionedCorrection = normalizeArchivedWaitObservation({
    ...input,
    accessMode: "single_rider",
    transformationVersion: "target-normalizer.v3"
  });
  assert.notEqual(original.normalized_observation_id, versionedCorrection.normalized_observation_id);
});

function withoutGeneratedAt(normalized) {
  const { generated_at: _generatedAt, ...semanticPayload } = normalized;
  return semanticPayload;
}

test("archive normalization rejects malformed raw fields, timestamps, and missing access mode", () => {
  const raw = rawObservation({ ordinal: 1 });
  const reference = lineReference(1);
  const run = (rawObservationInput, overrides = {}) => normalizeArchivedWaitObservation({
    rawObservation: rawObservationInput,
    archiveLineReference: overrides.archiveLineReference || reference,
    catalogEntries,
    accessMode: overrides.accessMode ?? "standby",
    generatedAt: "2026-09-24T18:00:00.000Z",
    ...overrides
  });

  const missingSourceUrl = { ...raw };
  delete missingSourceUrl.source_url;
  assert.throws(() => run(missingSourceUrl), (error) => error.code === "INVALID_RAW_OBSERVATION");
  assert.throws(() => run({ ...raw, wait_time_minutes: 1.5 }), (error) => error.code === "INVALID_WAIT");
  assert.throws(() => run({ ...raw, wait_time_minutes: -1 }), (error) => error.code === "INVALID_WAIT");
  assert.throws(() => run({ ...raw, snapshot_utc: "2026-09-24T17:15:00" }),
    (error) => error.code === "INVALID_TIMESTAMP");
  assert.throws(() => run({ ...raw, source_last_updated_utc: "2026-09-24T17:14:00" }),
    (error) => error.code === "INVALID_TIMESTAMP");
  assert.throws(() => run(raw, { generatedAt: "2026-09-24" }),
    (error) => error.code === "INVALID_TIMESTAMP");
  assert.throws(() => run(raw, { generatedAt: "2026-09-24T18:00:00" }),
    (error) => error.code === "INVALID_TIMESTAMP");
  assert.throws(() => run(raw, { generatedAt: "2026-09-24T10:00:00-08:00" }),
    (error) => error.code === "INVALID_TIMESTAMP");
  assert.throws(() => run(raw, { generatedAt: "not-a-dateZ" }),
    (error) => error.code === "INVALID_TIMESTAMP");
  assert.throws(() => run(raw, {
    archiveLineReference: { ...reference, raw_payload: { source_name: "not a reference field" } }
  }), (error) => error.code === "INVALID_ARCHIVE_LINE_REFERENCE");
  assert.throws(() => normalizeArchivedWaitObservation({
    rawObservation: rawObservation({ ordinal: 1, rideName: "Soarin' Across America Single Rider" }),
    archiveLineReference: reference,
    catalogEntries,
    generatedAt: "2026-09-24T18:00:00.000Z"
  }), (error) => error.code === "ACCESS_MODE_REQUIRED");
});

test("raw v1 required properties and additionalProperties:false are enforced", async () => {
  const schema = JSON.parse(await readFile(
    path.join(root, "packages/contracts/schemas/v1/raw-wait-observation.schema.json"),
    "utf8"
  ));
  const valid = rawObservation({ ordinal: 1 });
  assert.equal(schema.additionalProperties, false);

  for (const field of schema.required) {
    const missingRequiredField = { ...valid };
    delete missingRequiredField[field];
    assert.throws(() => normalizeRaw(missingRequiredField),
      (error) => error.code === "INVALID_RAW_OBSERVATION");
  }

  assert.throws(() => normalizeRaw({ ...valid, raw_payload: { ride_name: "not a v1 property" } }),
    (error) => error.code === "INVALID_RAW_OBSERVATION");
});

test("raw v1 optional fields enforce declared string, date, and wait types", () => {
  const valid = rawObservation({ ordinal: 1 });
  for (const field of ["snapshot_park_datetime", "park_name", "land", "source_last_updated_park_datetime"]) {
    assert.throws(() => normalizeRaw({ ...valid, [field]: {} }),
      (error) => error.code === "INVALID_RAW_OBSERVATION");
  }

  assert.throws(() => normalizeRaw({ ...valid, snapshot_park_date: "2026-02-30" }),
    (error) => error.code === "INVALID_RAW_OBSERVATION");
  assert.throws(() => normalizeRaw({ ...valid, wait_time_minutes: "20" }),
    (error) => error.code === "INVALID_WAIT");
  assert.throws(() => normalizeRaw({ ...valid, wait_time_minutes: undefined }),
    (error) => error.code === "INVALID_WAIT");
});

test("archive normalization fails closed on unknown identity, timezone, date, and lineage", () => {
  assert.throws(() => normalize({ ordinal: 1, rideName: "Unmapped Fixture Attraction" }),
    (error) => error.code === "UNKNOWN_CANONICAL_ATTRACTION");
  assert.throws(() => normalize({ ordinal: 1, snapshotTimezone: "Not/A_Timezone" }),
    (error) => error.code === "INVALID_TIMEZONE");
  assert.throws(() => normalize({ ordinal: 1, snapshotTimezone: "Etc/UTC" }),
    (error) => error.code === "INVALID_RAW_OBSERVATION");
  assert.throws(() => normalize({ ordinal: 1, snapshotParkDate: "2026-09-25" }),
    (error) => error.code === "PARK_DATE_MISMATCH");
  assert.throws(() => normalize({
    ordinal: 1,
    archiveLineReference: { ...lineReference(1), raw_observation_id: "f".repeat(64) }
  }), (error) => error.code === "LINEAGE_MISMATCH");
});

function normalizeRaw(rawObservationInput, archiveLineReference = lineReference(1)) {
  return normalizeArchivedWaitObservation({
    rawObservation: rawObservationInput,
    archiveLineReference,
    catalogEntries,
    accessMode: "standby",
    generatedAt: "2026-09-24T18:00:00.000Z"
  });
}

function normalize({
  ordinal,
  rideName = "Soarin' Across America",
  isOpen = true,
  wait = 15,
  snapshotTimezone = "America/Los_Angeles",
  snapshotParkDate = "2026-09-24",
  archiveLineReference = lineReference(ordinal),
  catalogEntries: entries = catalogEntries,
  accessMode = "standby",
  sourceUpdatedUtc = "2026-09-24T17:14:00.000Z"
}) {
  return normalizeArchivedWaitObservation({
    rawObservation: rawObservation({
      ordinal,
      rideName,
      isOpen,
      wait,
      snapshotTimezone,
      snapshotParkDate,
      sourceUpdatedUtc
    }),
    archiveLineReference,
    catalogEntries: entries,
    accessMode,
    generatedAt: "2026-09-24T18:00:00.000Z"
  });
}

function catalogEntryWithLifecycle(overrides) {
  const entry = catalogEntries[0];
  return {
    ...entry,
    lifecycle: {
      ...entry.lifecycle,
      wait_capability: "posted_standby",
      supported_access_modes: ["standby", "single_rider"],
      operational_state: "operating",
      training_disposition: "eligible",
      planning_disposition: "eligible",
      evidence: [{
        source_type: "official_disney_app",
        source_url: null,
        verified_at: "2026-09-24T00:00:00.000Z",
        reviewed_by: "synthetic-test-fixture",
        notes: "Synthetic evidence fixture for isolated tests only; never production catalog data."
      }],
      ...overrides
    }
  };
}

function rawObservation({
  ordinal,
  rideName = "Soarin' Across America",
  isOpen = true,
  wait = 15,
  snapshotTimezone = "America/Los_Angeles",
  snapshotParkDate = "2026-09-24",
  snapshotUtc = "2026-09-24T17:15:00.000Z",
  sourceUpdatedUtc = "2026-09-24T17:14:00.000Z",
  sourceUrl = "fixture://wait-source"
}) {
  const rawObservationId = createHash("sha256").update(`${archiveSha256}:${ordinal}`, "utf8").digest("hex");
  return {
    contract_version: "raw-wait-observation.v1",
    raw_observation_id: rawObservationId,
    raw_archive_id: archiveSha256,
    source_row_number: ordinal,
    snapshot_utc: snapshotUtc,
    snapshot_park_datetime: "2026-09-24 10:15:00",
    snapshot_park_date: snapshotParkDate,
    snapshot_timezone: snapshotTimezone,
    park_id: "dca",
    park_name: "Disney California Adventure",
    land: "Grizzly Peak",
    ride_id: "soarin",
    ride_name: rideName,
    is_open: isOpen,
    wait_time_minutes: wait,
    source_last_updated_utc: sourceUpdatedUtc,
    source_last_updated_park_datetime: "2026-09-24 10:14:00",
    source_url: sourceUrl
  };
}

function lineReference(ordinal) {
  const rawObservationId = createHash("sha256").update(`${archiveSha256}:${ordinal}`, "utf8").digest("hex");
  return {
    contract_version: "raw-archive-line-reference.v1",
    raw_observation_id: rawObservationId,
    raw_archive_id: archiveSha256,
    r2_uri: "s3://fixture-bucket/archives/sample.csv",
    archive_sha256: archiveSha256,
    archive_byte_size: archiveBytes.byteLength,
    source_line_number: ordinal,
    source_name: "sample.csv",
    archive_schema_version: "raw-wait-observation.v1"
  };
}

const catalogEntries = [{
  contract_version: "catalog-entry.v1",
  operator_id: "disney",
  resort_id: "disneyland-resort",
  park_id: "dca",
  aliases: ["Soarin' Across America", "Soarin’ Across America", "Soarin' Over California"],
  canonical_attraction_id: "dca-soarin",
  canonical_attraction_name: "Soarin'",
  canonical_category: "attraction",
  lifecycle: {
    contract_version: "catalog-attraction-lifecycle.v1",
    canonical_attraction_id: "dca-soarin",
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
      verified_at: "2026-09-24T00:00:00.000Z",
      reviewed_by: "synthetic-fixture",
      notes: "Synthetic unresolved fixture; no official lifecycle claim."
    }],
    valid_from: "2026-01-01",
    valid_to: null,
    catalog_version: "fixture.v1",
    generated_at: "2026-09-24T00:00:00.000Z"
  }
}];
