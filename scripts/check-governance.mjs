import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredFiles = [
  "AGENTS.md",
  "docs/architecture/overview.md",
  "docs/architecture/context-map.md",
  "docs/architecture/dependency-rules.md",
  "docs/architecture/data-flow.md",
  "docs/architecture/migration-roadmap.md",
  "docs/ai/context-map.md",
  "docs/templates/module-readme.md",
  "modules/catalog/README.md",
  "modules/ingestion/README.md",
  "modules/observations/README.md",
  "modules/forecasting/README.md",
  "modules/planning/README.md",
  "apps/web/README.md",
  "apps/api/README.md",
  "workers/collector/README.md",
  "packages/contracts/README.md",
  "infra/README.md"
];

const failures = [];

for (const relativePath of requiredFiles) {
  try {
    await access(path.join(root, relativePath));
  } catch {
    failures.push(`Missing required governance file: ${relativePath}`);
  }
}

const agents = await readFile(path.join(root, "AGENTS.md"), "utf8");
for (const requiredRule of [
  "canonical_attraction_id",
  "Raw source observations are immutable",
  "npm run check",
  "Current Transition Constraint"
]) {
  if (!agents.includes(requiredRule)) failures.push(`AGENTS.md is missing required rule text: ${requiredRule}`);
}

const architecture = await readFile(path.join(root, "docs/architecture/overview.md"), "utf8");
for (const requiredTerm of ["current product scope", "Disney California Adventure", "future possibilities", "modular monorepo", "Current Reality"]) {
  if (!architecture.includes(requiredTerm)) failures.push(`Architecture overview is missing: ${requiredTerm}`);
}

if (/first intended product markets|intended initial product markets/i.test(architecture)) {
  failures.push("Architecture overview incorrectly treats future parks as initial product markets.");
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Governance check passed (${requiredFiles.length} required files).`);
}
