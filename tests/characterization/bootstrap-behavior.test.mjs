import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtures = path.join(root, "tests", "characterization", "fixtures");

test("collector uses the park-hours buffer as its collection window", async (t) => {
  const sandbox = await makeSandbox(t);
  const preload = pathToFileURL(path.join(root, "tests", "characterization", "mock-collector-runtime.mjs")).href;

  const inside = await runNode(sandbox, ["--import", preload, "scripts/collect-wait-times.mjs"], {
    CHARACTERIZATION_NOW: "2026-07-01T15:30:00.000Z"
  });
  assert.match(inside.stdout, /no parks are inside their collection windows/);
  assert.equal((inside.stdout.match(/outside park hours collection window/g) || []).length, 0);

  const outside = await runNode(sandbox, ["--import", preload, "scripts/collect-wait-times.mjs"], {
    CHARACTERIZATION_NOW: "2026-07-01T15:29:59.000Z"
  });
  assert.match(outside.stdout, /Skipped Disneyland: outside park hours collection window/);
  assert.match(outside.stdout, /Skipped Disney California Adventure: outside park hours collection window/);
});

test("collector normalization preserves quoted CSV fields and fills legacy timezone columns", async (t) => {
  const sandbox = await makeSandbox(t);
  const target = path.join(sandbox, "data", "wait_times", "wait_times_2026-07-02.csv");
  await copyFile(path.join(fixtures, "legacy_wait_times_2026-07-02.csv"), target);

  await runNode(sandbox, ["scripts/collect-wait-times.mjs", "--normalize-only"]);
  const rows = parseCsv(await readFile(target, "utf8"));
  const header = rows[0];
  const record = Object.fromEntries(header.map((key, index) => [key.replace(/^\uFEFF/, ""), rows[1][index]]));
  assert.equal(record.land, "Mickey's Toontown, East");
  assert.equal(record.ride_name, "Mickey's House, and Meet Mickey Mouse");
  assert.equal(record.snapshot_park_date, "2026-07-02");
  assert.equal(record.snapshot_timezone, "America/Los_Angeles");
});

test("analysis resolves aliases to one stable canonical attraction", async (t) => {
  const { cleaned } = await analyzeFixture(t);
  const soarin = cleaned.filter((row) => row.ride_name.startsWith("Soarin'"));
  assert.deepEqual(new Set(soarin.map((row) => row.canonical_attraction_id)), new Set(["dca-soarin"]));
  assert.equal(soarin.find((row) => row.ride_id === "standby-stale").canonical_match_source, "alias_exact");
  assert.equal(soarin.find((row) => row.ride_id === "sr-zero").canonical_match_source, "alias_base");
});

test("analysis distinguishes closed zero from an observed open zero wait", async (t) => {
  const { cleaned } = await analyzeFixture(t);
  const closed = cleaned.find((row) => row.ride_id === "closed-ride");
  const openZero = cleaned.find((row) => row.ride_id === "open-zero");
  assert.equal(closed.wait_time_minutes, "0");
  assert.equal(closed.observed_wait_time_minutes, "");
  assert.match(closed.quality_flags, /closed/);
  assert.equal(closed.training_eligibility, "status_model_only");
  assert.equal(openZero.observed_wait_time_minutes, "0");
  assert.match(openZero.quality_flags, /open_zero/);
  assert.equal(openZero.training_eligibility, "standby_wait_model");
});

test("analysis keeps Single Rider as a distinct access mode and uses positive waits as references", async (t) => {
  const { cleaned, optimizer } = await analyzeFixture(t);
  const singleRider = cleaned.filter((row) => row.is_single_rider === "TRUE");
  assert.ok(singleRider.every((row) => row.access_mode === "single_rider"));
  assert.ok(singleRider.every((row) => row.training_eligibility === "single_rider_optimizer_reference"));
  assert.equal(optimizer.find((row) => row.selected_ride_id === "sr-zero").optimizer_wait_weight_minutes, "0");
  assert.equal(optimizer.find((row) => row.selected_ride_id === "sr-positive").optimizer_wait_weight_minutes, "15");
});

test("optimizer projection selects the fresh eligible canonical candidate", async (t) => {
  const { optimizer } = await analyzeFixture(t);
  const standby = optimizer.find(
    (row) => row.canonical_attraction_id === "dca-soarin" && row.access_mode === "standby"
  );
  assert.equal(standby.selected_ride_id, "standby-fresh");
  assert.equal(standby.candidate_count, "2");
  assert.equal(standby.optimizer_wait_weight_minutes, "25");
  assert.equal(standby.resolver_reason, "selected_best_non_stale_candidate");
});

async function analyzeFixture(t) {
  const sandbox = await makeSandbox(t);
  await copyFile(
    path.join(fixtures, "wait_times_2026-07-01.csv"),
    path.join(sandbox, "data", "wait_times", "wait_times_2026-07-01.csv")
  );
  await runNode(sandbox, ["scripts/analyze-wait-times.mjs", "--date=2026-07-01"]);
  return {
    cleaned: await readObjects(path.join(sandbox, "data", "processed", "wait_times", "wait_times_cleaned_2026-07-01.csv")),
    optimizer: await readObjects(path.join(sandbox, "data", "processed", "optimizer", "optimizer_ready_wait_times_2026-07-01.csv"))
  };
}

async function makeSandbox(t) {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "disney-characterization-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  for (const directory of ["scripts", "data/wait_times", "data/catalog", "src/cache/themeparks"]) {
    await mkdir(path.join(sandbox, directory), { recursive: true });
  }
  await copyFile(path.join(root, "scripts", "collect-wait-times.mjs"), path.join(sandbox, "scripts", "collect-wait-times.mjs"));
  await copyFile(path.join(root, "scripts", "analyze-wait-times.mjs"), path.join(sandbox, "scripts", "analyze-wait-times.mjs"));
  await copyFile(path.join(root, "data", "catalog", "attraction-aliases.csv"), path.join(sandbox, "data", "catalog", "attraction-aliases.csv"));
  for (const park of ["disneyland", "dca"]) {
    await writeFile(path.join(sandbox, "src", "cache", "themeparks", `${park}.schedule.json`), '{"schedule":[]}\n');
  }
  return sandbox;
}

async function runNode(cwd, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...extraEnv } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`node ${args.join(" ")} exited ${code}\n${stdout}\n${stderr}`)));
  });
}

async function readObjects(file) {
  const rows = parseCsv(await readFile(file, "utf8"));
  const header = rows.shift().map((value) => value.replace(/^\uFEFF/, ""));
  return rows.filter((row) => row.some(Boolean)).map((row) => Object.fromEntries(header.map((key, index) => [key, row[index] ?? ""])));
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted && char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { row.push(field); field = ""; }
    else if (char === "\n" && !quoted) { row.push(field); rows.push(row); row = []; field = ""; }
    else if (char !== "\r") field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}
