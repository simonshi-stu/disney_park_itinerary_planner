import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const outputDir = path.join(rootDir, "data", "wait_times");
const parkTimezone = "America/Los_Angeles";
const csvBom = "\uFEFF";
const normalizeOnly = process.argv.includes("--normalize-only");
const forceCollect = process.argv.includes("--force");
const minSnapshotIntervalMinutes = Number(process.env.MIN_SNAPSHOT_INTERVAL_MINUTES || 5);

const parks = [
  { id: "disneyland", name: "Disneyland", queueTimesParkId: 16, timezone: parkTimezone },
  { id: "dca", name: "Disney California Adventure", queueTimesParkId: 17, timezone: parkTimezone }
];

const snapshotTime = new Date();
const snapshotIso = snapshotTime.toISOString();
const snapshotLocal = formatInTimezone(snapshotTime, parkTimezone);
const snapshotDate = snapshotLocal.date;
const csvPath = path.join(outputDir, `wait_times_${snapshotDate}.csv`);
const latestPath = path.join(outputDir, "latest_snapshot.json");

await mkdir(outputDir, { recursive: true });

const header = [
  "snapshot_utc",
  "snapshot_park_datetime",
  "snapshot_park_date",
  "snapshot_timezone",
  "park_id",
  "park_name",
  "land",
  "ride_id",
  "ride_name",
  "is_open",
  "wait_time_minutes",
  "source_last_updated_utc",
  "source_last_updated_park_datetime",
  "source_url"
];

if (normalizeOnly) {
  const filenames = await readdir(outputDir);
  const csvFilenames = filenames.filter((filename) => /^wait_times_\d{4}-\d{2}-\d{2}\.csv$/.test(filename));

  for (const filename of csvFilenames) {
    const filePath = path.join(outputDir, filename);
    await writeCsv(filePath, await readExistingRows(filePath));
  }

  console.log(`Normalized ${csvFilenames.length} wait-time CSV file(s) in ${outputDir}`);
  process.exit(0);
}

const existingRows = await readExistingRows(csvPath);
const latestExistingSnapshot = getLatestSnapshotTime(existingRows);
const minutesSinceLatestSnapshot = latestExistingSnapshot
  ? (snapshotTime.getTime() - latestExistingSnapshot.getTime()) / 60000
  : Infinity;

if (!forceCollect && minutesSinceLatestSnapshot < minSnapshotIntervalMinutes) {
  console.log(
    `Skipped wait-time collection because the latest snapshot is ${minutesSinceLatestSnapshot.toFixed(1)} minutes old. ` +
      `Use --force to collect anyway.`
  );
  process.exit(0);
}

const rows = [];

for (const park of parks) {
  const url = `https://queue-times.com/parks/${park.queueTimesParkId}/queue_times.json`;
  const response = await fetch(url, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }

  const data = await response.json();
  const lands = Array.isArray(data.lands) ? data.lands : [];
  const rootRides = Array.isArray(data.rides) ? data.rides : [];

  for (const land of lands) {
    for (const ride of land.rides || []) {
      rows.push(toRow(snapshotIso, park, land.name, ride, url));
    }
  }

  for (const ride of rootRides) {
    rows.push(toRow(snapshotIso, park, "Other", ride, url));
  }
}

await writeCsv(csvPath, [...existingRows, ...rows]);
await writeFile(
  latestPath,
  `${JSON.stringify(
    {
      snapshotUtc: snapshotIso,
      snapshotParkDatetime: snapshotLocal.dateTime,
      snapshotParkDate: snapshotLocal.date,
      snapshotTimezone: parkTimezone,
      rowCount: rows.length,
      rows
    },
    null,
    2
  )}\n`,
  "utf8"
);

console.log(`Collected ${rows.length} wait-time rows into ${csvPath}`);

function toRow(snapshotUtc, park, land, ride, sourceUrl) {
  const sourceLastUpdatedUtc = ride.last_updated || "";

  return {
    snapshot_utc: snapshotUtc,
    snapshot_park_datetime: formatTimestampInTimezone(snapshotUtc, park.timezone),
    snapshot_park_date: formatTimestampInTimezone(snapshotUtc, park.timezone).slice(0, 10),
    snapshot_timezone: park.timezone,
    park_id: park.id,
    park_name: cleanText(park.name),
    land: cleanText(land),
    ride_id: ride.id,
    ride_name: cleanText(ride.name),
    is_open: ride.is_open ? "TRUE" : "FALSE",
    wait_time_minutes: Number.isFinite(ride.wait_time) ? ride.wait_time : "",
    source_last_updated_utc: sourceLastUpdatedUtc,
    source_last_updated_park_datetime: formatTimestampInTimezone(sourceLastUpdatedUtc, park.timezone),
    source_url: sourceUrl
  };
}

async function readExistingRows(filePath) {
  try {
    const text = stripBom(await readFile(filePath, "utf8")).trimEnd();
    if (!text) return [];

    const records = parseCsv(text);
    const existingHeader = records.shift() || [];

    return records
      .filter((record) => record.some((value) => value !== ""))
      .map((record) => normalizeExistingRow(Object.fromEntries(existingHeader.map((key, index) => [key, record[index] ?? ""]))));
  } catch {
    return [];
  }
}

async function writeCsv(filePath, rows) {
  const csv = [
    header.join(","),
    ...rows.map((row) => header.map((key) => csvEscape(row[key])).join(","))
  ].join("\n");

  await writeFile(filePath, `${csvBom}${csv}\n`, "utf8");
}

function normalizeExistingRow(row) {
  const snapshotParkDatetime = row.snapshot_park_datetime || formatTimestampInTimezone(row.snapshot_utc, parkTimezone);
  const sourceLastUpdatedParkDatetime =
    row.source_last_updated_park_datetime || formatTimestampInTimezone(row.source_last_updated_utc, parkTimezone);

  return {
    snapshot_utc: row.snapshot_utc || "",
    snapshot_park_datetime: snapshotParkDatetime,
    snapshot_park_date: row.snapshot_park_date || snapshotParkDatetime.slice(0, 10),
    snapshot_timezone: row.snapshot_timezone || parkTimezone,
    park_id: row.park_id || "",
    park_name: cleanText(row.park_name),
    land: cleanText(row.land),
    ride_id: row.ride_id || "",
    ride_name: cleanText(row.ride_name),
    is_open: row.is_open || "",
    wait_time_minutes: row.wait_time_minutes || "",
    source_last_updated_utc: row.source_last_updated_utc || "",
    source_last_updated_park_datetime: sourceLastUpdatedParkDatetime,
    source_url: row.source_url || ""
  };
}

function getLatestSnapshotTime(rows) {
  const timestamps = rows
    .map((row) => new Date(row.snapshot_utc))
    .filter((date) => !Number.isNaN(date.getTime()));

  if (!timestamps.length) return null;

  return new Date(Math.max(...timestamps.map((date) => date.getTime())));
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/Indiana Jones\uFFFD\?Adventure/g, "Indiana Jones\u2122 Adventure")
    .replace(/Soarin\uFFFD\?Across America/g, "Soarin\u2019 Across America")
    .replace(/Pixar Pal-A-Round \uFFFD\?Non-Swinging/g, "Pixar Pal-A-Round \u2013 Non-Swinging");
}

function formatTimestampInTimezone(value, timezone) {
  if (!value) return "";

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return formatInTimezone(date, timezone).dateTime;
}

function formatInTimezone(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const dateText = `${values.year}-${values.month}-${values.day}`;
  const timeText = `${values.hour}:${values.minute}:${values.second}`;

  return {
    date: dateText,
    time: timeText,
    dateTime: `${dateText} ${timeText}`
  };
}

function stripBom(text) {
  return text.startsWith(csvBom) ? text.slice(1) : text;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}
