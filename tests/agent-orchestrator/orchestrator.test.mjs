import test from "node:test";
import assert from "node:assert/strict";
import { buildContextPack, extractPatch, extractPatchFiles, isExcludedContextPath, parseWorkerContent, validateControllerReview, validateManifest, validateWorkerResult } from "../../tools/agent-orchestrator.mjs";

test("manifest validation accepts the project migration manifest shape", () => {
  const manifest = {
    manifest_version: "1",
    phases: [{
      id: "phase-1",
      title: "Example",
      objective: "Example objective",
      allowed_paths: ["packages/contracts"],
      required_reads: ["AGENTS.md"],
      acceptance: ["test"],
      commands: ["npm.cmd run check"]
    }]
  };
  assert.equal(validateManifest(manifest), manifest);
});

test("manifest validation rejects duplicate phase ids", () => {
  assert.throws(() => validateManifest({
    manifest_version: "1",
    phases: [
      { id: "same", title: "a", objective: "a", allowed_paths: ["a"], required_reads: [], acceptance: [], commands: [] },
      { id: "same", title: "b", objective: "b", allowed_paths: ["b"], required_reads: [], acceptance: [], commands: [] }
    ]
  }), /Duplicate phase id/);
});

test("worker diff is extracted without applying it", () => {
  const content = "summary\n```diff\ndiff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@\n-old\n+new\n```";
  assert.match(extractPatch(content), /diff --git/);
  assert.match(extractPatch(content), /\+new/);
});

test("worker JSON parser accepts a complete first object with a code fence and trailing noise", () => {
  const content = '```json\n{"summary":"ok","files_changed":[],"patch":"diff with { braces } in a string"}]';
  const parsed = parseWorkerContent(content);
  assert.equal(parsed.summary, "ok");
  assert.equal(parsed.patch, "diff with { braces } in a string");
  assert.equal(parsed.raw_content, undefined);
});

test("worker JSON parser still rejects a truncated object", () => {
  const parsed = parseWorkerContent('{"summary":"truncated","patch":"diff');
  assert.deepEqual(parsed.files_changed, []);
  assert.deepEqual(parsed.risks, ["invalid_worker_json"]);
  assert.match(parsed.raw_content, /truncated/);
});

test("controller rejects a worker that declares files missing from its patch", () => {
  const patch = "diff --git a/packages/contracts/a.json b/packages/contracts/a.json\n--- a/packages/contracts/a.json\n+++ b/packages/contracts/a.json\n@@ -1 +1 @@\n-old\n+new\n";
  assert.deepEqual(extractPatchFiles(patch), ["packages/contracts/a.json"]);
  const validation = validateWorkerResult({
    allowed_paths: ["packages/contracts", "tests/catalog"],
    required_outputs: ["packages/contracts/a.json", "tests/catalog/a.test.mjs"]
  }, {
    files_changed: ["packages/contracts/a.json", "tests/catalog/a.test.mjs"],
    patch
  });
  assert.equal(validation.status, "revise");
  assert.match(validation.errors.join("\n"), /declared files missing from patch/);
  assert.match(validation.errors.join("\n"), /required outputs missing from patch/);
});

test("controller accepts a complete patch inside the phase allowlist", () => {
  const patch = [
    "diff --git a/packages/contracts/a.json b/packages/contracts/a.json",
    "--- a/packages/contracts/a.json",
    "+++ b/packages/contracts/a.json",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/tests/catalog/a.test.mjs b/tests/catalog/a.test.mjs",
    "--- a/tests/catalog/a.test.mjs",
    "+++ b/tests/catalog/a.test.mjs",
    "@@ -1 +1 @@",
    "-old",
    "+new"
  ].join("\n");
  const validation = validateWorkerResult({
    allowed_paths: ["packages/contracts", "tests/catalog"],
    required_outputs: ["packages/contracts/a.json", "tests/catalog/a.test.mjs"]
  }, {
    files_changed: ["packages/contracts/a.json", "tests/catalog/a.test.mjs"],
    patch
  });
  assert.equal(validation.status, "ready_for_codex_review");
});

test("controller review requires evidence and implementation logic rather than replacement code", () => {
  const review = {
    review_version: "1",
    status: "revise",
    summary: "Catalog semantics are mixed.",
    error_types: [{
      type: "architecture",
      severity: "blocking",
      evidence: "catalog schema uses a singular observation access_mode",
      required_logic: "keep lifecycle capability separate and model supported access modes as metadata"
    }],
    required_changes: ["Revise the schema and its tests."],
    resolved_in_run: false
  };
  assert.equal(validateControllerReview(review), review);
  assert.throws(() => validateControllerReview({
    ...review,
    error_types: [{ type: "architecture", evidence: "missing logic" }]
  }), /required_logic/);
});

test("context policy excludes production history and dependencies", () => {
  assert.equal(isExcludedContextPath("data/wait_times/2026-08-05.csv"), true);
  assert.equal(isExcludedContextPath("node_modules/pg/index.js"), true);
  assert.equal(isExcludedContextPath("docs/data/migration-runbook.zh-CN.md"), false);
  assert.equal(isExcludedContextPath("packages/contracts/README.zh-CN.md"), false);
});

test("phase context includes source files under the allowed paths", async () => {
  const manifest = {
    context_roots: ["AGENTS.md"],
    context_policy: { max_file_chars: 5000, max_total_chars: 30000 },
    phases: []
  };
  const phase = {
    required_reads: ["AGENTS.md"],
    allowed_paths: ["packages/contracts"]
  };
  const pack = await buildContextPack(manifest, phase, "phase");
  assert.match(pack.text, /AGENTS\.md/);
  assert.match(pack.text, /packages\/contracts/);
  assert.equal(pack.index.omitted_files.some((entry) => entry.path.startsWith("data/")), false);
});
