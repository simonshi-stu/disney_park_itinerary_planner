import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditRepositoryWaitTimeHistory } from "../modules/observations/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const date = getArgValue("--date");
const summaryOnly = process.argv.includes("--summary");
const report = await auditRepositoryWaitTimeHistory(root, { date });

if (summaryOnly) {
  console.log(JSON.stringify({
    contract_version: report.contract_version,
    policy_version: report.policy_version,
    generated_at: report.generated_at,
    scope: report.scope,
    summary: report.summary,
    forecast_readiness: report.forecast_readiness,
    incomplete_operating_days: report.daily_coverage.filter((day) => !day.is_complete),
    sustained_unavailability_review: report.attraction_availability.filter(
      (ride) => ride.availability_disposition === "sustained_unavailability_review"
    )
  }, null, 2));
} else {
  console.log(JSON.stringify(report, null, 2));
}

function getArgValue(name) {
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) || null;
}
