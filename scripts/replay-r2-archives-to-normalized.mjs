import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOfflineReplayCheckReport } from "../infra/backfill/r2-normalized-records.mjs";

const usage = "Usage: node scripts/replay-r2-archives-to-normalized.mjs --check";

/**
 * Offline gate only. `--check` is the sole supported flag; there is deliberately
 * no R2, PostgreSQL, environment, or network adapter here, and no local
 * authoritative inputs exist to execute an injected dry-run.
 */
export function runReplayOfflineCheck(args, io = {}) {
  const writeStdout = io.writeStdout || ((text) => process.stdout.write(text));
  const writeStderr = io.writeStderr || ((text) => process.stderr.write(text));
  if (!Array.isArray(args) || args.length !== 1 || args[0] !== "--check") {
    writeStderr(`${usage}\n`);
    return 2;
  }
  writeStdout(`${JSON.stringify(buildOfflineReplayCheckReport(), null, 2)}\n`);
  return 0;
}

function main(args) {
  process.exitCode = runReplayOfflineCheck(args);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2));
}
