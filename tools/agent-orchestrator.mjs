#!/usr/bin/env node

import fs from "node:fs/promises";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TOOL_DIR, "..");
const execFileAsync = promisify(execFile);

function usage() {
  return `
Usage:
  node tools/agent-orchestrator.mjs plan <manifest.json>
  node tools/agent-orchestrator.mjs run <manifest.json> --phase=<phase-id> [--context=phase|full] [--attempts=1|2|3] [--dry-run] [--review=manual|openai]
  node tools/agent-orchestrator.mjs revise <run-directory> --review-file=<review.json> [--attempts=1|2|3]

Environment variables for DeepSeek:
  DEEPSEEK_API_KEY   required for a real worker call
  DEEPSEEK_MODEL     optional; defaults to deepseek-chat
  DEEPSEEK_BASE_URL  optional; defaults to https://api.deepseek.com
  AGENT_CONTEXT_MAX_CHARS optional; defaults to 180000

Environment variables for optional OpenAI review:
  OPENAI_API_KEY     required only with --review=openai
  OPENAI_MODEL       required only with --review=openai
  OPENAI_BASE_URL    optional; defaults to https://api.openai.com/v1
`;
}

function parseArgs(argv) {
  const [command, manifestPath, ...rest] = argv;
  const options = {};
  for (const value of rest) {
    if (value === "--dry-run") options.dryRun = true;
    else if (value.startsWith("--phase=")) options.phase = value.slice("--phase=".length);
    else if (value.startsWith("--context=")) options.contextMode = value.slice("--context=".length);
    else if (value.startsWith("--attempts=")) options.attempts = Number(value.slice("--attempts=".length));
    else if (value.startsWith("--review=")) options.review = value.slice("--review=".length);
    else if (value.startsWith("--review-file=")) options.reviewFile = value.slice("--review-file=".length);
    else throw new Error(`Unknown option: ${value}`);
  }
  return { command, manifestPath, options };
}

const DEFAULT_CONTEXT_POLICY = {
  max_file_chars: 24_000,
  max_total_chars: 180_000,
  include_extensions: [".md", ".mjs", ".js", ".json", ".sql", ".yml", ".yaml", ".ts", ".tsx"],
  exclude_paths: [
    ".git",
    ".agent-runs",
    "node_modules",
    "data",
    "outputs",
    "src/cache",
    "dist",
    "build",
    "coverage",
    ".next"
  ],
  exclude_files: [
    ".env",
    ".env.local",
    "latest_snapshot.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock"
  ]
};

export function validateManifest(manifest) {
  if (!manifest || manifest.manifest_version !== "1") {
    throw new Error("Manifest must contain manifest_version=1");
  }
  if (!Array.isArray(manifest.phases) || manifest.phases.length === 0) {
    throw new Error("Manifest must contain at least one phase");
  }
  const ids = new Set();
  for (const phase of manifest.phases) {
    for (const field of ["id", "title", "objective", "allowed_paths", "required_reads", "acceptance", "commands"]) {
      if (!(field in phase)) throw new Error(`Phase ${phase.id ?? "unknown"} is missing ${field}`);
    }
    if (ids.has(phase.id)) throw new Error(`Duplicate phase id: ${phase.id}`);
    ids.add(phase.id);
    if (!Array.isArray(phase.allowed_paths) || phase.allowed_paths.length === 0) {
      throw new Error(`Phase ${phase.id} must have allowed_paths`);
    }
  }
  return manifest;
}

async function loadManifest(manifestPath) {
  const absolutePath = path.resolve(REPO_ROOT, manifestPath);
  const manifest = JSON.parse(await fs.readFile(absolutePath, "utf8"));
  return validateManifest(manifest);
}

async function loadStatus(manifest) {
  if (!manifest.status_file) return { phases: {} };
  try {
    return JSON.parse(await fs.readFile(path.resolve(REPO_ROOT, manifest.status_file), "utf8"));
  } catch (error) {
    throw new Error(`Cannot read status file ${manifest.status_file}: ${error.message}`);
  }
}

function getPhase(manifest, phaseId) {
  const phase = manifest.phases.find((candidate) => candidate.id === phaseId);
  if (!phase) throw new Error(`Unknown phase: ${phaseId}`);
  return phase;
}

function normalizeRelativePath(relativePath) {
  return relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isWithinRepo(absolutePath) {
  const relative = path.relative(REPO_ROOT, absolutePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isExcludedContextPath(relativePath, policy = DEFAULT_CONTEXT_POLICY) {
  const normalized = normalizeRelativePath(relativePath);
  if (policy.exclude_files.includes(path.basename(normalized))) return true;
  return policy.exclude_paths.some((excluded) => {
    const normalizedExcluded = normalizeRelativePath(excluded).replace(/\/$/, "");
    return normalized === normalizedExcluded || normalized.startsWith(`${normalizedExcluded}/`);
  });
}

function isCandidateContextFile(relativePath, policy) {
  if (isExcludedContextPath(relativePath, policy)) return false;
  const basename = path.basename(relativePath);
  if (basename === "AGENTS.md" || basename.startsWith("README")) return true;
  return policy.include_extensions.includes(path.extname(basename).toLowerCase());
}

async function walkContextRoot(relativeRoot, policy) {
  const normalizedRoot = normalizeRelativePath(relativeRoot || ".");
  const absoluteRoot = path.resolve(REPO_ROOT, normalizedRoot);
  if (!isWithinRepo(absoluteRoot)) throw new Error(`Context root escapes repository: ${relativeRoot}`);
  let stat;
  try {
    stat = await fs.stat(absoluteRoot);
  } catch {
    return [];
  }
  if (stat.isFile()) return isCandidateContextFile(normalizedRoot, policy) ? [normalizedRoot] : [];
  if (!stat.isDirectory()) return [];
  const result = [];
  const entries = await fs.readdir(absoluteRoot, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = normalizeRelativePath(path.join(normalizedRoot, entry.name));
    if (isExcludedContextPath(relativePath, policy)) continue;
    if (entry.isDirectory()) result.push(...await walkContextRoot(relativePath, policy));
    else if (entry.isFile() && isCandidateContextFile(relativePath, policy)) result.push(relativePath);
  }
  return result;
}

function hashText(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

async function readContextFile(relativePath, policy, required) {
  const absolutePath = path.resolve(REPO_ROOT, relativePath);
  if (!isWithinRepo(absolutePath)) throw new Error(`Context file escapes repository: ${relativePath}`);
  let content;
  try {
    content = await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    if (required) throw new Error(`Cannot read required context ${relativePath}: ${error.message}`);
    return null;
  }
  if (/sk-[A-Za-z0-9_-]{20,}/.test(content) || /AKIA[0-9A-Z]{16}/.test(content) || /BEGIN [A-Z ]*PRIVATE KEY/.test(content)) {
    throw new Error(`Refusing to send secret-like content from ${relativePath}`);
  }
  const maxFileChars = policy.max_file_chars;
  const clipped = content.length > maxFileChars;
  return {
    path: normalizeRelativePath(relativePath),
    sha256: hashText(content),
    source_chars: content.length,
    included_chars: Math.min(content.length, maxFileChars),
    clipped,
    required,
    text: clipped ? `${content.slice(0, maxFileChars)}\n...[file clipped by context policy]...` : content
  };
}

export async function buildContextPack(manifest, phase, mode = "phase", overrides = {}) {
  const policy = {
    ...DEFAULT_CONTEXT_POLICY,
    ...(manifest.context_policy || {}),
    ...overrides
  };
  policy.max_total_chars = Number(overrides.max_total_chars || process.env.AGENT_CONTEXT_MAX_CHARS || policy.max_total_chars);
  const requiredPaths = [...new Set(phase.required_reads.map(normalizeRelativePath))];
  const roots = mode === "full"
    ? ["."]
    : [...new Set([...(manifest.context_roots || []), ...phase.allowed_paths])];
  const autoPaths = (await Promise.all(roots.map((root) => walkContextRoot(root, policy)))).flat();
  const orderedPaths = [...new Set([...requiredPaths, ...autoPaths])].filter((relativePath) => !isExcludedContextPath(relativePath, policy));
  const entries = [];
  const pieces = [];
  let totalChars = 0;
  for (const relativePath of orderedPaths) {
    const required = requiredPaths.includes(relativePath);
    const entry = await readContextFile(relativePath, policy, required);
    if (!entry) continue;
    const header = `\n===== ${entry.path} (${required ? "required" : "auto-context"}) =====\n`;
    const remaining = policy.max_total_chars - totalChars;
    if (remaining <= header.length) {
      entries.push({ ...entry, included_chars: 0, omitted: true, omitted_reason: "total_context_limit" });
      continue;
    }
    const body = entry.text.slice(0, Math.max(0, remaining - header.length));
    pieces.push(`${header}${body}`);
    totalChars += header.length + body.length;
    entries.push({ ...entry, included_chars: body.length, omitted: body.length < entry.text.length, omitted_reason: body.length < entry.text.length ? "total_context_limit" : undefined });
  }
  const index = {
    mode,
    max_total_chars: policy.max_total_chars,
    total_chars: totalChars,
    file_count: entries.length,
    included_files: entries.filter((entry) => !entry.omitted).map((entry) => entry.path),
    omitted_files: entries.filter((entry) => entry.omitted).map((entry) => ({ path: entry.path, reason: entry.omitted_reason })),
    files: entries.map(({ text, ...metadata }) => metadata)
  };
  const preamble = `CONTEXT PACK\nMode: ${mode}\nFiles are supplied in deterministic order. Raw/generated data, dependencies, caches, .env files and secret-like content are intentionally excluded. Do not infer that an omitted generated-data file is absent from the repository.\n`;
  return { text: `${preamble}${pieces.join("\n")}`, index };
}

function buildWorkerPrompt(manifest, phase, contextPack) {
  return `You are the DeepSeek coding worker for a guarded repository task.

Project: ${manifest.project}
Phase: ${phase.id} - ${phase.title}
Objective: ${phase.objective}

Allowed paths (do not change anything else):
${phase.allowed_paths.map((value) => `- ${value}`).join("\n")}

Acceptance criteria:
${phase.acceptance.map((value) => `- ${value}`).join("\n")}

Decisions already made by the project owner (do not reopen these questions):
${(phase.decisions || []).map((value) => `- ${value}`).join("\n") || "- None beyond the supplied contracts and ADRs."}

Required patch outputs:
${(phase.required_outputs || []).map((value) => `- ${value}`).join("\n") || "- No exact filenames mandated."}

Commands the controller will run:
${phase.commands.map((value) => `- ${value}`).join("\n")}

Global rules:
- Do not modify generated production data, credentials, or applied migrations.
- Do not claim that tests passed unless you actually ran them.
- If a requirement is ambiguous, report it instead of guessing.
- Do not apply changes to the working tree from this response.
- The files_changed list must exactly match the files present in the unified diff.
- Return every required output in one complete patch, including tests and documentation.

Return a JSON object with these keys:
summary, files_changed, tests_to_run, risks, questions, patch.
The patch value must be a unified git diff in a string. If no safe patch can be proposed, return patch as an empty string and explain why.

Context policy:
- Read every supplied file before proposing a patch.
- Treat the context index as authoritative for what was included and clipped.
- If required context is missing or clipped at a critical section, report a question instead of guessing.
- Do not request raw CSV/history uploads; use schemas, reports and small fixtures.

Context index:
${JSON.stringify(contextPack.index, null, 2)}

Supplied context:
${contextPack.text}`;
}

function rejectSecretLikeText(text) {
  if (/sk-[A-Za-z0-9_-]{20,}/.test(text)) {
    throw new Error("Refusing to send a prompt containing a secret-like sk- token");
  }
}

async function callChatCompletion({ baseUrl, apiKey, model, messages }) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ model, messages, temperature: 0.1, stream: false })
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Model request failed (${response.status}): ${body.slice(0, 500)}`);
  return JSON.parse(body);
}

function extractContent(response) {
  return response?.choices?.[0]?.message?.content ?? "";
}

export function extractPatch(content) {
  const match = content.match(/```diff\s*([\s\S]*?)```/i);
  return match ? match[1].trim() : "";
}

function extractFirstJsonObject(content) {
  const start = content.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < content.length; index += 1) {
    const character = content[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return content.slice(start, index + 1);
      if (depth < 0) return null;
    }
  }
  return null;
}

export function parseWorkerContent(content) {
  const withoutFence = content.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    const jsonObject = extractFirstJsonObject(withoutFence);
    if (!jsonObject) throw new Error("Worker JSON object is incomplete");
    const parsed = JSON.parse(jsonObject);
    return { ...parsed, patch: parsed.patch || extractPatch(content) };
  } catch {
    return {
      summary: "Worker did not return valid JSON; raw response requires review.",
      files_changed: [],
      tests_to_run: [],
      risks: ["invalid_worker_json"],
      questions: [],
      patch: extractPatch(content),
      raw_content: content
    };
  }
}

export function extractPatchFiles(patchText) {
  return [...patchText.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((match) => normalizeRelativePath(match[2].trim()));
}

function pathIsAllowed(relativePath, allowedPaths) {
  const normalized = normalizeRelativePath(relativePath);
  return allowedPaths.some((allowedPath) => {
    const normalizedAllowed = normalizeRelativePath(allowedPath).replace(/\/$/, "");
    return normalized === normalizedAllowed || normalized.startsWith(`${normalizedAllowed}/`);
  });
}

export function validateWorkerResult(phase, workerResult) {
  const patchFiles = [...new Set(extractPatchFiles(workerResult.patch || ""))];
  const declaredFiles = [...new Set((workerResult.files_changed || []).map(normalizeRelativePath))];
  const requiredOutputs = (phase.required_outputs || []).map(normalizeRelativePath);
  const errors = [];
  if (patchFiles.length === 0) errors.push("worker returned an empty patch");
  const declaredButMissing = declaredFiles.filter((file) => !patchFiles.includes(file));
  const patchButUndeclared = patchFiles.filter((file) => !declaredFiles.includes(file));
  const requiredMissing = requiredOutputs.filter((file) => !patchFiles.includes(file));
  const outsideAllowlist = patchFiles.filter((file) => !pathIsAllowed(file, phase.allowed_paths));
  if (declaredButMissing.length) errors.push(`declared files missing from patch: ${declaredButMissing.join(", ")}`);
  if (patchButUndeclared.length) errors.push(`patch files missing from files_changed: ${patchButUndeclared.join(", ")}`);
  if (requiredMissing.length) errors.push(`required outputs missing from patch: ${requiredMissing.join(", ")}`);
  if (outsideAllowlist.length) errors.push(`patch paths outside allowlist: ${outsideAllowlist.join(", ")}`);
  return {
    status: errors.length ? "revise" : "ready_for_codex_review",
    errors,
    patch_files: patchFiles,
    declared_files: declaredFiles,
    required_outputs: requiredOutputs,
    outside_allowlist: outsideAllowlist
  };
}

export function validateControllerReview(review) {
  if (!review || review.review_version !== "1") throw new Error("Controller review must contain review_version=1");
  if (!["accepted", "revise", "blocked", "human_gate"].includes(review.status)) {
    throw new Error("Controller review status must be accepted, revise, blocked, or human_gate");
  }
  if (!Array.isArray(review.error_types) || !Array.isArray(review.required_changes)) {
    throw new Error("Controller review must contain error_types and required_changes arrays");
  }
  for (const error of review.error_types) {
    if (!error.type || !error.evidence || !error.required_logic) {
      throw new Error("Every controller error requires type, evidence, and required_logic");
    }
  }
  return review;
}

async function validatePatchApplies(patchPath) {
  try {
    await execFileAsync("git", ["apply", "--check", "--whitespace=error", "--recount", "--no-index", patchPath], {
      cwd: REPO_ROOT,
      windowsHide: true
    });
    return { applies: true, error: null };
  } catch (error) {
    return { applies: false, error: (error.stderr || error.message || "git apply --check failed").trim() };
  }
}

function buildReviewPrompt(manifest, phase, workerResult, controllerValidation) {
  return `You are the GPT/Codex reviewer for a guarded coding phase.

Project: ${manifest.project}
Phase: ${phase.id} - ${phase.title}
Acceptance criteria:
${phase.acceptance.map((value) => `- ${value}`).join("\n")}

Review the worker result below. Check scope, contracts, data invariants, tests, security, and rollback behavior. Do not assume code works merely because the worker says so. Do not write replacement production code or a corrected patch. Your role is only to classify errors, cite evidence, and explain the required implementation logic so the DeepSeek worker can revise.

Return JSON only using this shape:
{
  "review_version": "1",
  "status": "accepted|revise|blocked|human_gate",
  "summary": "short outcome",
  "error_types": [{
    "type": "incomplete_task|architecture|business_rule|contract|test_gap|scope|security|patch_integrity",
    "severity": "blocking|major|minor",
    "evidence": "exact file/diff evidence",
    "required_logic": "implementation logic the worker must follow"
  }],
  "required_changes": ["ordered worker instructions"],
  "resolved_in_run": false
}

Deterministic controller validation:
${JSON.stringify(controllerValidation, null, 2)}

Worker result:
${JSON.stringify(workerResult, null, 2)}`;
}

function buildRunReport({ phase, attempts, workerResult, controllerValidation, semanticReview = null, parentRun = null }) {
  const structuralStatus = controllerValidation?.status || "unknown";
  const semanticStatus = semanticReview?.status || "pending_codex_review";
  const resolved = structuralStatus === "ready_for_codex_review" && semanticStatus === "accepted";
  return `# Agent Run Report

- Phase: ${phase.id} - ${phase.title}
- Parent run: ${parentRun || "none"}
- Worker attempts: ${attempts}
- Structural validation: ${structuralStatus}
- Semantic review: ${semanticStatus}
- Resolved in this run: ${resolved ? "yes" : "no"}

## Proposed changes

${(workerResult?.files_changed || []).map((file) => `- ${file}`).join("\n") || "- none"}

## Structural problems

${(controllerValidation?.errors || []).map((error) => `- ${error}`).join("\n") || "- none"}

## Worker risks

${(workerResult?.risks || []).map((risk) => `- ${risk}`).join("\n") || "- none reported"}

## Controller semantic errors

${(semanticReview?.error_types || []).map((error) => `- [${error.type}/${error.severity}] ${error.evidence} Required logic: ${error.required_logic}`).join("\n") || "- pending Codex review"}

## Required next action

${(semanticReview?.required_changes || []).map((change) => `- ${change}`).join("\n") || "- Complete Codex audit using review-prompt.md, then either accept or create controller-review.json for DeepSeek revision."}
`;
}

async function writeRunFile(runDir, filename, value) {
  await fs.writeFile(path.join(runDir, filename), value, "utf8");
}

async function runPhase(manifest, phase, options) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(REPO_ROOT, ".agent-runs", `${phase.id}-${timestamp}`);
  await fs.mkdir(runDir, { recursive: true });
  const contextMode = options.contextMode || "phase";
  if (!["phase", "full"].includes(contextMode)) throw new Error("--context must be phase or full");
  const contextPack = await buildContextPack(manifest, phase, contextMode);
  const workerPrompt = buildWorkerPrompt(manifest, phase, contextPack);
  rejectSecretLikeText(workerPrompt);
  await writeRunFile(runDir, "manifest.json", `${JSON.stringify({ manifest_version: manifest.manifest_version, phase }, null, 2)}\n`);
  await writeRunFile(runDir, "context-index.json", `${JSON.stringify(contextPack.index, null, 2)}\n`);
  await writeRunFile(runDir, "context-pack.md", contextPack.text);
  await writeRunFile(runDir, "worker-prompt.md", workerPrompt);

  if (options.dryRun) {
    console.log(`Dry run complete. Prompt written to ${path.relative(REPO_ROOT, path.join(runDir, "worker-prompt.md"))}`);
    return;
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not set; use --dry-run or configure a secret");
  const maxAttempts = options.attempts || 2;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new Error("--attempts must be an integer from 1 to 3");
  const messages = [
    { role: "system", content: "You are a careful repository coding worker. Never reveal or request secrets. Return complete, internally consistent JSON." },
    { role: "user", content: workerPrompt }
  ];
  let response;
  let workerContent;
  let workerResult;
  let controllerValidation;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    response = await callChatCompletion({
      baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
      apiKey,
      model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
      messages
    });
    workerContent = extractContent(response);
    workerResult = parseWorkerContent(workerContent);
    controllerValidation = validateWorkerResult(phase, workerResult);
    await writeRunFile(runDir, `worker-response-attempt-${attempt}.json`, `${JSON.stringify(response, null, 2)}\n`);
    const attemptPatchPath = path.join(runDir, `worker-attempt-${attempt}.patch`);
    await fs.writeFile(attemptPatchPath, workerResult.patch || "", "utf8");
    if (workerResult.patch) {
      const patchCheck = await validatePatchApplies(attemptPatchPath);
      controllerValidation.patch_check = patchCheck;
      if (!patchCheck.applies) {
        controllerValidation.status = "revise";
        controllerValidation.errors.push(`git apply --check failed: ${patchCheck.error}`);
      }
    }
    await writeRunFile(runDir, `controller-validation-attempt-${attempt}.json`, `${JSON.stringify(controllerValidation, null, 2)}\n`);
    if (controllerValidation.status === "ready_for_codex_review" || attempt === maxAttempts) break;
    messages.push(
      { role: "assistant", content: workerContent },
      {
        role: "user",
        content: `Your patch failed deterministic controller validation:\n${controllerValidation.errors.map((error) => `- ${error}`).join("\n")}\nReturn a complete replacement JSON response. Do not merely describe the missing files; include them in the unified diff and keep files_changed exactly consistent with the diff.`
      }
    );
  }
  await writeRunFile(runDir, "worker-response.json", `${JSON.stringify(response, null, 2)}\n`);
  await writeRunFile(runDir, "worker-result.json", `${JSON.stringify(workerResult, null, 2)}\n`);
  await writeRunFile(runDir, "controller-validation.json", `${JSON.stringify(controllerValidation, null, 2)}\n`);
  await writeRunFile(runDir, "worker.patch", workerResult.patch || "");

  const reviewPrompt = buildReviewPrompt(manifest, phase, workerResult, controllerValidation);
  rejectSecretLikeText(reviewPrompt);
  await writeRunFile(runDir, "review-prompt.md", reviewPrompt);
  await writeRunFile(runDir, "controller-review-template.json", `${JSON.stringify({
    review_version: "1",
    status: "revise",
    summary: "Replace with the Codex audit outcome.",
    error_types: [{
      type: "incomplete_task",
      severity: "blocking",
      evidence: "Replace with exact diff or file evidence.",
      required_logic: "Replace with the implementation logic DeepSeek must follow."
    }],
    required_changes: ["Replace with ordered DeepSeek revision instructions."],
    resolved_in_run: false
  }, null, 2)}\n`);
  await writeRunFile(runDir, "run-report.md", buildRunReport({
    phase,
    attempts: maxAttempts,
    workerResult,
    controllerValidation
  }));

  if ((options.review || "manual") === "openai") {
    const reviewKey = process.env.OPENAI_API_KEY;
    const reviewModel = process.env.OPENAI_MODEL;
    if (!reviewKey || !reviewModel) throw new Error("OPENAI_API_KEY and OPENAI_MODEL are required for --review=openai");
    const reviewResponse = await callChatCompletion({
      baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      apiKey: reviewKey,
      model: reviewModel,
      messages: [
        { role: "system", content: "You are a strict code reviewer. Return JSON only." },
        { role: "user", content: reviewPrompt }
      ]
    });
    await writeRunFile(runDir, "review-response.json", `${JSON.stringify(reviewResponse, null, 2)}\n`);
    const reviewContent = extractContent(reviewResponse).replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    const semanticReview = validateControllerReview(JSON.parse(reviewContent));
    await writeRunFile(runDir, "controller-review.json", `${JSON.stringify(semanticReview, null, 2)}\n`);
    await writeRunFile(runDir, "run-report.md", buildRunReport({
      phase,
      attempts: maxAttempts,
      workerResult,
      controllerValidation,
      semanticReview
    }));
    console.log(reviewContent);
  } else {
    console.log(`Worker result and Codex review prompt written to ${path.relative(REPO_ROOT, runDir)}`);
  }
}

async function reviseRun(parentRunPath, options) {
  if (!options.reviewFile) throw new Error("revise requires --review-file=<review.json>");
  const parentRun = path.resolve(REPO_ROOT, parentRunPath);
  const runsRoot = path.resolve(REPO_ROOT, ".agent-runs");
  if (!isWithinRepo(parentRun) || !parentRun.startsWith(runsRoot)) throw new Error("Revision parent must be inside .agent-runs");
  const parentManifest = JSON.parse(await fs.readFile(path.join(parentRun, "manifest.json"), "utf8"));
  const phase = parentManifest.phase;
  const workerPrompt = await fs.readFile(path.join(parentRun, "worker-prompt.md"), "utf8");
  const previousWorkerResult = JSON.parse(await fs.readFile(path.join(parentRun, "worker-result.json"), "utf8"));
  const reviewPath = path.resolve(REPO_ROOT, options.reviewFile);
  if (!isWithinRepo(reviewPath)) throw new Error("Controller review file must be inside the repository");
  const controllerReview = validateControllerReview(JSON.parse(await fs.readFile(reviewPath, "utf8")));
  if (controllerReview.status !== "revise") throw new Error(`Cannot call DeepSeek revision for review status ${controllerReview.status}`);

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not set");
  const maxAttempts = options.attempts || 2;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new Error("--attempts must be an integer from 1 to 3");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(runsRoot, `${phase.id}-revision-${timestamp}`);
  await fs.mkdir(runDir, { recursive: true });
  await writeRunFile(runDir, "manifest.json", `${JSON.stringify(parentManifest, null, 2)}\n`);
  await writeRunFile(runDir, "worker-prompt.md", workerPrompt);
  await writeRunFile(runDir, "parent-controller-review.json", `${JSON.stringify(controllerReview, null, 2)}\n`);
  await writeRunFile(runDir, "parent-run.txt", `${normalizeRelativePath(path.relative(REPO_ROOT, parentRun))}\n`);

  const feedback = `The Codex Controller rejected the previous patch. You must revise the implementation; Codex will not write the code for you.\n\nController errors:\n${controllerReview.error_types.map((error) => `- [${error.type}/${error.severity}] Evidence: ${error.evidence}\n  Required logic: ${error.required_logic}`).join("\n")}\n\nRequired changes:\n${controllerReview.required_changes.map((change) => `- ${change}`).join("\n")}\n\nReturn a complete replacement JSON response and unified diff. files_changed must exactly match the diff. Do not merely explain the correction.`;
  const messages = [
    { role: "system", content: "You are the DeepSeek coding worker. Codex only audits; you must produce the corrected complete code patch." },
    { role: "user", content: workerPrompt },
    { role: "assistant", content: JSON.stringify(previousWorkerResult) },
    { role: "user", content: feedback }
  ];
  let response;
  let workerContent;
  let workerResult;
  let controllerValidation;
  let attemptsUsed = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attemptsUsed = attempt;
    response = await callChatCompletion({
      baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
      apiKey,
      model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
      messages
    });
    workerContent = extractContent(response);
    workerResult = parseWorkerContent(workerContent);
    controllerValidation = validateWorkerResult(phase, workerResult);
    await writeRunFile(runDir, `worker-response-attempt-${attempt}.json`, `${JSON.stringify(response, null, 2)}\n`);
    const attemptPatchPath = path.join(runDir, `worker-attempt-${attempt}.patch`);
    await fs.writeFile(attemptPatchPath, workerResult.patch || "", "utf8");
    if (workerResult.patch) {
      const patchCheck = await validatePatchApplies(attemptPatchPath);
      controllerValidation.patch_check = patchCheck;
      if (!patchCheck.applies) {
        controllerValidation.status = "revise";
        controllerValidation.errors.push(`git apply --check failed: ${patchCheck.error}`);
      }
    }
    await writeRunFile(runDir, `controller-validation-attempt-${attempt}.json`, `${JSON.stringify(controllerValidation, null, 2)}\n`);
    if (controllerValidation.status === "ready_for_codex_review" || attempt === maxAttempts) break;
    messages.push(
      { role: "assistant", content: workerContent },
      { role: "user", content: `The replacement patch still failed deterministic validation:\n${controllerValidation.errors.map((error) => `- ${error}`).join("\n")}\nReturn another complete replacement JSON and diff.` }
    );
  }
  await writeRunFile(runDir, "worker-response.json", `${JSON.stringify(response, null, 2)}\n`);
  await writeRunFile(runDir, "worker-result.json", `${JSON.stringify(workerResult, null, 2)}\n`);
  await writeRunFile(runDir, "controller-validation.json", `${JSON.stringify(controllerValidation, null, 2)}\n`);
  await writeRunFile(runDir, "worker.patch", workerResult.patch || "");
  const reviewPrompt = buildReviewPrompt({ project: "disney-park-itinerary-planner" }, phase, workerResult, controllerValidation);
  await writeRunFile(runDir, "review-prompt.md", reviewPrompt);
  await writeRunFile(runDir, "run-report.md", buildRunReport({
    phase,
    attempts: attemptsUsed,
    workerResult,
    controllerValidation,
    parentRun: normalizeRelativePath(path.relative(REPO_ROOT, parentRun))
  }));
  console.log(`Revised Worker result and Codex review prompt written to ${path.relative(REPO_ROOT, runDir)}`);
}

async function main(argv) {
  const { command, manifestPath, options } = parseArgs(argv);
  if (!command || !manifestPath || !["plan", "run", "revise"].includes(command)) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (command === "revise") {
    await reviseRun(manifestPath, options);
    return;
  }
  const manifest = await loadManifest(manifestPath);
  if (command === "plan") {
    const status = await loadStatus(manifest);
    console.log(`${manifest.project} - ${manifest.purpose}`);
    for (const phase of manifest.phases) {
      const phaseStatus = status.phases?.[phase.id]?.status || "untracked";
      console.log(`${phase.id}: ${phase.title} [${phaseStatus}]${phase.human_gate ? ` [human gate: ${phase.human_gate}]` : ""}`);
    }
    return;
  }
  if (!options.phase) throw new Error("run requires --phase=<phase-id>");
  await runPhase(manifest, getPhase(manifest, options.phase), options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Agent orchestrator failed: ${error.message}`);
    process.exitCode = 1;
  });
}
