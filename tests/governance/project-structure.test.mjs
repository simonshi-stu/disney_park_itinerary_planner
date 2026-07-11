import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("bootstrap runtime entrypoints remain in their current locations", async () => {
  for (const relativePath of [
    "src/app.js",
    "scripts/collect-wait-times.mjs",
    "scripts/analyze-wait-times.mjs",
    "scripts/update-cache.mjs"
  ]) {
    await assert.doesNotReject(access(path.join(root, relativePath)));
  }
});

test("all target domain modules document ownership and current status", async () => {
  for (const name of ["catalog", "ingestion", "observations", "forecasting", "planning"]) {
    const content = await readFile(path.join(root, "modules", name, "README.md"), "utf8");
    assert.match(content, /## Purpose/);
    assert.match(content, /## Current Status/);
  }
});

test("governance distinguishes current implementation from target architecture", async () => {
  const overview = await readFile(path.join(root, "docs/architecture/overview.md"), "utf8");
  assert.match(overview, /## Current Reality/);
  assert.match(overview, /## Target Shape/);
  assert.match(overview, /California Disneyland Park and Disney California Adventure/);
  assert.match(overview, /Shanghai Disney Resort and Hong Kong Disneyland/);
});

test("collector migration decision preserves the bootstrap collector", async () => {
  const adr = await readFile(path.join(root, "docs/adr/0004-maintain-node-collector-during-governance.md"), "utf8");
  assert.match(adr, /Maintain the current Node\.js collector/);
  assert.match(adr, /characterization tests/i);
});
