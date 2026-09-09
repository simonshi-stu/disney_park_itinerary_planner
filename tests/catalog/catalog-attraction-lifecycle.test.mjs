import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("catalog lifecycle contract separates capability, access mode, and lifecycle", async () => {
  const schema = JSON.parse(await readFile(
    path.join(root, "packages/contracts/schemas/v1/catalog-attraction-lifecycle.schema.json"),
    "utf8"
  ));
  assert.equal(schema.properties.contract_version.const, "catalog-attraction-lifecycle.v1");
  assert.deepEqual(schema.properties.wait_capability.enum, ["posted_standby", "schedule_only", "no_queue", "unknown"]);
  assert.deepEqual(schema.properties.supported_access_modes.items.enum, ["standby", "single_rider", "virtual_queue", "other"]);
  assert.equal(schema.properties.access_mode, undefined);
  assert.deepEqual(schema.properties.operational_state.enum, ["operating", "refurbishment", "seasonal", "retired", "unknown"]);
});

test("catalog lifecycle contract preserves official evidence and effective dates", async () => {
  const schema = JSON.parse(await readFile(
    path.join(root, "packages/contracts/schemas/v1/catalog-attraction-lifecycle.schema.json"),
    "utf8"
  ));
  assert.ok(schema.required.includes("valid_from"));
  assert.ok(schema.required.includes("valid_to"));
  assert.equal(schema.properties.park_timezone.const, "America/Los_Angeles");
  assert.deepEqual(
    schema.properties.evidence.items.properties.source_type.enum,
    ["official_disney_page", "official_disney_app", "manual_review"]
  );
  assert.deepEqual(
    schema.properties.evidence.items.required,
    ["source_type", "source_url", "verified_at", "reviewed_by"]
  );
  assert.deepEqual(
    schema.allOf[2].then.properties.evidence.contains.properties.source_type.enum,
    ["official_disney_page", "official_disney_app"]
  );
});

test("catalog lifecycle contract blocks unsafe prediction and planning dispositions", async () => {
  const schema = JSON.parse(await readFile(
    path.join(root, "packages/contracts/schemas/v1/catalog-attraction-lifecycle.schema.json"),
    "utf8"
  ));
  const unavailable = schema.allOf[0];
  assert.deepEqual(unavailable.if.properties.operational_state.enum, ["refurbishment", "retired"]);
  assert.equal(unavailable.then.properties.training_disposition.const, "ineligible_lifecycle");
  assert.equal(unavailable.then.properties.planning_disposition.const, "ineligible_lifecycle");
  const unknown = schema.allOf[1];
  assert.equal(unknown.then.properties.training_disposition.const, "review_required");
  assert.equal(unknown.then.properties.planning_disposition.const, "review_required");
});
