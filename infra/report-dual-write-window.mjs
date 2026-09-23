import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareDualWriteWindow } from "../modules/ingestion/source-health.mjs";

export async function reportDualWriteWindow(inputPath) {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    throw new TypeError("an input JSON path is required");
  }
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  return compareDualWriteWindow(input);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await reportDualWriteWindow(process.argv[2]);
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== "passed") process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
