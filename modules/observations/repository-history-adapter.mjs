import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { auditWaitTimeHistory } from "./internal/wait-time-quality.mjs";

const parkSchedules = [
  { parkId: "disneyland", path: "src/cache/themeparks/disneyland.schedule.json" },
  { parkId: "dca", path: "src/cache/themeparks/dca.schedule.json" }
];

export async function auditRepositoryWaitTimeHistory(root, options = {}) {
  const rawDir = path.join(root, "data", "wait_times");
  const filenames = (await readdir(rawDir))
    .filter((name) => /^wait_times_\d{4}-\d{2}-\d{2}\.csv$/.test(name))
    .filter((name) => !options.date || name.includes(options.date))
    .sort();
  const rows = [];
  for (const filename of filenames) {
    rows.push(...parseCsv(await readFile(path.join(rawDir, filename), "utf8")));
  }
  const observedDates = new Set(rows.map((row) => row.snapshot_park_date).filter(Boolean));

  const operatingWindows = [];
  for (const scheduleSource of parkSchedules) {
    const payload = JSON.parse(await readFile(path.join(root, scheduleSource.path), "utf8"));
    for (const entry of Array.isArray(payload.schedule) ? payload.schedule : []) {
      if (entry.type !== "OPERATING") continue;
      if (options.date && entry.date !== options.date) continue;
      if (!observedDates.has(entry.date)) continue;
      operatingWindows.push({
        date: entry.date,
        parkId: scheduleSource.parkId,
        openingTime: entry.openingTime,
        closingTime: entry.closingTime
      });
    }
  }

  return auditWaitTimeHistory({ rows, operatingWindows }, options);
}

function parseCsv(text) {
  const source = String(text).replace(/^\uFEFF/, "");
  const records = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some((value) => value !== "")) records.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    records.push(row);
  }
  const [header, ...values] = records;
  if (!header) return [];
  return values.map((record) =>
    Object.fromEntries(header.map((key, index) => [key, record[index] ?? ""]))
  );
}
