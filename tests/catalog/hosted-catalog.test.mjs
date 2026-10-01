import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveCanonicalAttraction } from "../../modules/catalog/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const asOfDate = "2026-09-24";

test("catalog-entry.v1 versions the exact resolver input and references lifecycle v1", async () => {
  const schema = JSON.parse(await readFile(
    path.join(root, "packages/contracts/schemas/v1/catalog-entry.schema.json"),
    "utf8"
  ));
  assert.equal(schema.properties.contract_version.const, "catalog-entry.v1");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    "contract_version",
    "operator_id",
    "resort_id",
    "park_id",
    "aliases",
    "canonical_attraction_id",
    "canonical_attraction_name",
    "canonical_category",
    "lifecycle"
  ]);
  assert.deepEqual(schema.properties.lifecycle, { $ref: "catalog-attraction-lifecycle.schema.json" });
  assert.equal(schema.properties.aliases.type, "array");
  assert.equal(schema.properties.aliases.items.type, "string");
  assert.deepEqual(schema.properties.canonical_category.enum, ["attraction", "entertainment"]);
});

test("injected aliases resolve deterministically, park-scoped, with suffix fallback only", () => {
  const input = {
    parkId: "dca",
    sourceAttractionName: "Soarin’ Across America",
    catalogEntries,
    asOfDate
  };
  const exact = resolveCanonicalAttraction(input);
  assert.equal(exact.canonical_attraction_id, "dca-soarin");
  assert.equal(exact.canonical_attraction_name, "Soarin'");
  assert.equal(exact.canonical_match_source, "alias_exact");
  assert.equal(exact.operational_state, "unknown");
  assert.equal(exact.training_disposition, "review_required");
  assert.deepEqual(exact, resolveCanonicalAttraction(input));

  const singleRider = resolveCanonicalAttraction({
    ...input,
    sourceAttractionName: "Soarin' Across America Single Rider"
  });
  assert.equal(singleRider.canonical_attraction_id, "dca-soarin");
  assert.equal(singleRider.canonical_match_source, "alias_base");

  const entertainment = resolveCanonicalAttraction({
    ...input,
    sourceAttractionName: "World of Color Happiness!"
  });
  assert.equal(entertainment.canonical_attraction_id, "dca-world-of-color");
  assert.equal(entertainment.canonical_category, "entertainment");
  assert.equal(entertainment.wait_capability, "schedule_only");
});

test("unknown, cross-park, and ambiguous aliases fail closed", () => {
  assert.throws(
    () => resolveCanonicalAttraction({
      parkId: "dca",
      sourceAttractionName: "Unmapped Test Attraction",
      catalogEntries,
      asOfDate
    }),
    (error) => error.code === "UNKNOWN_CANONICAL_ATTRACTION"
  );
  assert.throws(
    () => resolveCanonicalAttraction({
      parkId: "disneyland",
      sourceAttractionName: "Soarin' Across America",
      catalogEntries,
      asOfDate
    }),
    (error) => error.code === "UNKNOWN_CANONICAL_ATTRACTION"
  );

  const ambiguous = [catalogEntries[0], makeEntry({
    parkId: "dca",
    aliases: ["Soarin' Across America"],
    canonicalId: "dca-other-soarin",
    canonicalName: "Other Soarin"
  })];
  assert.throws(
    () => resolveCanonicalAttraction({
      parkId: "dca",
      sourceAttractionName: "Soarin' Across America",
      catalogEntries: ambiguous,
      asOfDate
    }),
    (error) => error.code === "AMBIGUOUS_CANONICAL_ATTRACTION"
  );
});

test("resolver rejects invalid catalog-entry versions and extra fields at each contract level", () => {
  const validEntry = catalogEntries[0];
  const noVersion = { ...validEntry };
  delete noVersion.contract_version;
  const invalidEntries = [
    { ...validEntry, contract_version: "catalog-entry.v2" },
    noVersion,
    { ...validEntry, source_payload: {} },
    { ...validEntry, aliases: [""] },
    { ...validEntry, canonical_category: "entrance" },
    { ...validEntry, lifecycle: { ...validEntry.lifecycle, source_payload: {} } },
    {
      ...validEntry,
      lifecycle: {
        ...validEntry.lifecycle,
        evidence: [{ ...validEntry.lifecycle.evidence[0], source_payload: {} }]
      }
    }
  ];

  for (const entry of invalidEntries) {
    assert.throws(() => resolve({ entry, name: "Soarin' Across America" }),
      (error) => error.code === "INVALID_CATALOG_ENTRY");
  }
});

test("resolver rejects catalog-entry versus lifecycle canonical-attraction and park identity mismatches", () => {
  const entry = catalogEntries[0];
  const mismatchedCanonical = {
    ...entry,
    lifecycle: { ...entry.lifecycle, canonical_attraction_id: "dca-other-attraction" }
  };
  const mismatchedPark = {
    ...entry,
    lifecycle: { ...entry.lifecycle, park_id: "disneyland" }
  };

  for (const invalidEntry of [mismatchedCanonical, mismatchedPark]) {
    assert.throws(() => resolve({ entry: invalidEntry, name: "Soarin' Across America" }),
      (error) => error.code === "INVALID_CATALOG_ENTRY");
  }
});

test("lifecycle evidence, dispositions, and half-open effective dates are enforced", () => {
  const unknown = resolveCanonicalAttraction({
    parkId: "disneyland",
    sourceAttractionName: "Mickey's House and Meet Mickey Mouse",
    catalogEntries,
    asOfDate
  });
  assert.equal(unknown.operational_state, "unknown");
  assert.equal(unknown.training_disposition, "review_required");
  assert.equal(unknown.planning_disposition, "review_required");

  const invalidRetired = makeEntry({
    parkId: "dca",
    aliases: ["Retired Test Ride"],
    canonicalId: "dca-retired-test-ride",
    canonicalName: "Retired Test Ride",
    lifecycle: lifecycle("dca-retired-test-ride", "dca", {
      operational_state: "retired",
      training_disposition: "eligible",
      planning_disposition: "eligible"
    })
  });
  assert.throws(() => resolve({ entry: invalidRetired, name: "Retired Test Ride" }),
    (error) => error.code === "INVALID_CATALOG_ENTRY" && /excluded from training and planning/.test(error.message));

  const missingOfficial = makeEntry({
    parkId: "dca",
    aliases: ["Unverified Test Ride"],
    canonicalId: "dca-unverified-test-ride",
    canonicalName: "Unverified Test Ride",
    lifecycle: lifecycle("dca-unverified-test-ride", "dca", {
      operational_state: "operating",
      wait_capability: "posted_standby",
      training_disposition: "eligible",
      planning_disposition: "eligible"
    })
  });
  assert.throws(() => resolve({ entry: missingOfficial, name: "Unverified Test Ride" }),
    (error) => error.code === "INVALID_CATALOG_ENTRY" && /require official Disney/.test(error.message));

  const malformedOfficialUri = makeEntry({
    parkId: "dca",
    aliases: ["Malformed Official URI"],
    canonicalId: "dca-malformed-official-uri",
    canonicalName: "Malformed Official URI",
    lifecycle: lifecycle("dca-malformed-official-uri", "dca", {
      operational_state: "operating",
      wait_capability: "posted_standby",
      training_disposition: "eligible",
      planning_disposition: "eligible",
      evidence: [{
        source_type: "official_disney_page",
        source_url: "https://",
        verified_at: "2026-09-24T00:00:00.000Z",
        reviewed_by: "synthetic-invalid-fixture"
      }]
    })
  });
  assert.throws(() => resolve({ entry: malformedOfficialUri, name: "Malformed Official URI" }),
    (error) => error.code === "INVALID_CATALOG_ENTRY");

  const startsToday = makeEntry({
    parkId: "dca",
    aliases: ["Date-Bounded Test Ride"],
    canonicalId: "dca-date-bounded-test-ride",
    canonicalName: "Date-Bounded Test Ride",
    lifecycle: lifecycle("dca-date-bounded-test-ride", "dca", { valid_from: asOfDate })
  });
  assert.equal(resolve({ entry: startsToday, name: "Date-Bounded Test Ride" }).canonical_attraction_id,
    "dca-date-bounded-test-ride");

  const endsToday = makeEntry({
    parkId: "dca",
    aliases: ["Date-Bounded Test Ride"],
    canonicalId: "dca-date-bounded-test-ride",
    canonicalName: "Date-Bounded Test Ride",
    lifecycle: lifecycle("dca-date-bounded-test-ride", "dca", {
      valid_from: "2026-01-01",
      valid_to: asOfDate
    })
  });
  assert.throws(() => resolve({ entry: endsToday, name: "Date-Bounded Test Ride" }),
    (error) => error.code === "CATALOG_LIFECYCLE_NOT_EFFECTIVE");
});

test("lifecycle evidence verified_at and generated_at require strict zoned date-times", () => {
  for (const [field, value] of [
    ["verified_at", "2026-09-24"],
    ["verified_at", "not-a-date-timeZ"],
    ["generated_at", "2026-09-24T00:00:00"],
    ["generated_at", "not-a-date-timeZ"]
  ]) {
    const invalidLifecycle = lifecycle("dca-invalid-time", "dca", field === "generated_at"
      ? { [field]: value }
      : { evidence: [{
        source_type: "manual_review",
        source_url: null,
        verified_at: value,
        reviewed_by: "synthetic-invalid-fixture"
      }] });
    const entry = makeEntry({
      parkId: "dca",
      aliases: ["Invalid Timestamp Fixture"],
      canonicalId: "dca-invalid-time",
      canonicalName: "Invalid Timestamp Fixture",
      lifecycle: invalidLifecycle
    });
    assert.throws(() => resolve({ entry, name: "Invalid Timestamp Fixture" }),
      (error) => error.code === "INVALID_CATALOG_ENTRY");
  }
});

function resolve({ entry, name }) {
  return resolveCanonicalAttraction({
    parkId: "dca",
    sourceAttractionName: name,
    catalogEntries: [entry],
    asOfDate
  });
}

function makeEntry({ parkId, aliases, canonicalId, canonicalName, category = "attraction", lifecycle: entryLifecycle }) {
  return {
    contract_version: "catalog-entry.v1",
    operator_id: "disney",
    resort_id: "disneyland-resort",
    park_id: parkId,
    aliases,
    canonical_attraction_id: canonicalId,
    canonical_attraction_name: canonicalName,
    canonical_category: category,
    lifecycle: entryLifecycle || lifecycle(canonicalId, parkId)
  };
}

function lifecycle(canonicalId, parkId, overrides = {}) {
  return {
    contract_version: "catalog-attraction-lifecycle.v1",
    canonical_attraction_id: canonicalId,
    park_id: parkId,
    park_timezone: "America/Los_Angeles",
    wait_capability: "unknown",
    supported_access_modes: ["standby"],
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
    generated_at: "2026-09-24T00:00:00.000Z",
    ...overrides
  };
}

const catalogEntries = [
  makeEntry({
    parkId: "dca",
    aliases: ["Soarin' Over California", "Soarin' Across America", "Soarin’ Across America", "Soarin' Around the World"],
    canonicalId: "dca-soarin",
    canonicalName: "Soarin'",
    lifecycle: lifecycle("dca-soarin", "dca", {
      supported_access_modes: ["standby", "single_rider"]
    })
  }),
  makeEntry({
    parkId: "dca",
    aliases: ["World of Color", "World of Color Happiness!"],
    canonicalId: "dca-world-of-color",
    canonicalName: "World of Color",
    category: "entertainment",
    lifecycle: lifecycle("dca-world-of-color", "dca", {
      supported_access_modes: ["other"],
      wait_capability: "schedule_only"
    })
  }),
  makeEntry({
    parkId: "disneyland",
    aliases: ["Mickey's House and Meet Mickey Mouse"],
    canonicalId: "disneyland-mickeys-house-and-meet-mickey-mouse",
    canonicalName: "Mickey's House and Meet Mickey Mouse",
    lifecycle: lifecycle("disneyland-mickeys-house-and-meet-mickey-mouse", "disneyland", {
      supported_access_modes: ["other"]
    })
  })
];
