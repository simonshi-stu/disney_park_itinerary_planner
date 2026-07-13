import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const transformationVersion = "bootstrap-analyzer.v0.5";
export const rawSchemaVersion = "raw-wait-observation.v1";

export async function buildBackfillPlan(root, options = {}) {
  const onlyDate = options.date || null;
  const rawDir = path.join(root, "data", "wait_times");
  const cleanedDir = path.join(root, "data", "processed", "wait_times");
  const aliasPath = path.join(root, "data", "catalog", "attraction-aliases.csv");
  const rawNames = (await readdir(rawDir))
    .filter((name) => /^wait_times_\d{4}-\d{2}-\d{2}\.csv$/.test(name))
    .filter((name) => !onlyDate || name.includes(onlyDate))
    .sort();
  const cleanedNames = new Set(
    (await readdir(cleanedDir))
      .filter((name) => /^wait_times_cleaned_\d{4}-\d{2}-\d{2}\.csv$/.test(name))
      .filter((name) => !onlyDate || name.includes(onlyDate))
  );

  const archives = [];
  const rawRecords = [];
  const normalizedRecords = [];
  const normalizedDates = [];
  const missingNormalizedDates = [];

  for (const rawName of rawNames) {
    const date = rawName.slice("wait_times_".length, -".csv".length);
    const filePath = path.join(rawDir, rawName);
    const content = await readFile(filePath);
    const sha256 = hash(content);
    const rows = parseCsv(content.toString("utf8"));
    validateRawRows(rows, rawName);
    const archive = { rawArchiveId: sha256, sha256, byteSize: content.byteLength, sourceName: rawName, filePath, content };
    archives.push(archive);

    const dateRawRecords = rows.map((row, index) => toRawRecord(row, archive, index + 1));
    rawRecords.push(...dateRawRecords);

    const cleanedName = `wait_times_cleaned_${date}.csv`;
    if (!cleanedNames.has(cleanedName)) {
      missingNormalizedDates.push(date);
      continue;
    }
    const cleanedRows = parseCsv(await readFile(path.join(cleanedDir, cleanedName), "utf8"));
    const rawBySourceIdentity = groupBy(dateRawRecords, sourceIdentity);
    cleanedRows.forEach((row, index) => {
      const candidates = rawBySourceIdentity.get(sourceIdentity(row));
      const rawRecord = candidates?.shift();
      if (!rawRecord) throw new Error(`${cleanedName}:${index + 2} has no matching raw lineage`);
      normalizedRecords.push(toNormalizedRecord(row, rawRecord, options.generatedAt));
    });
    normalizedDates.push(date);
  }

  const aliases = parseCsv(await readFile(aliasPath, "utf8"));
  const report = buildReport({ archives, rawRecords, normalizedRecords, normalizedDates, missingNormalizedDates, aliases });
  return { archives, rawRecords, normalizedRecords, aliases, report };
}

export function parseCsv(text) {
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
  return values.map((record) => Object.fromEntries(header.map((key, index) => [key, record[index] ?? ""])));
}

function toRawRecord(row, archive, sourceRowNumber) {
  return {
    rawObservationId: hash(`${archive.rawArchiveId}:${sourceRowNumber}`),
    rawArchiveId: archive.rawArchiveId,
    sourceRowNumber,
    snapshotUtc: row.snapshot_utc,
    snapshotParkDatetime: row.snapshot_park_datetime,
    snapshotParkDate: row.snapshot_park_date,
    snapshotTimezone: row.snapshot_timezone,
    parkId: row.park_id,
    parkName: row.park_name,
    land: row.land,
    rideId: row.ride_id,
    rideName: row.ride_name,
    isOpen: parseBoolean(row.is_open),
    waitTimeMinutes: parseNullableNumber(row.wait_time_minutes),
    sourceLastUpdatedUtc: row.source_last_updated_utc,
    sourceLastUpdatedParkDatetime: row.source_last_updated_park_datetime,
    sourceUrl: row.source_url
  };
}

function toNormalizedRecord(row, raw, generatedAt) {
  const isOpen = parseBoolean(row.is_open);
  const observedWait = parseNullableNumber(row.observed_wait_time_minutes);
  if (!isOpen && observedWait !== null) throw new Error(`Closed source row ${raw.rawObservationId} has a normalized wait`);
  return {
    normalizedObservationId: hash(`${raw.rawObservationId}:${transformationVersion}`),
    rawObservationId: raw.rawObservationId,
    canonicalAttractionId: row.canonical_attraction_id,
    canonicalAttractionName: row.canonical_attraction_name,
    canonicalCategory: row.canonical_category,
    canonicalMatchSource: row.canonical_match_source,
    accessMode: normalizeAccessMode(row.access_mode),
    isOpen,
    observedWaitTimeMinutes: observedWait,
    sourceAgeMinutes: parseNullableNumber(row.source_age_minutes),
    qualityFlags: row.quality_flags ? row.quality_flags.split("|").filter(Boolean) : [],
    trainingEligibility: row.training_eligibility,
    transformationVersion,
    generatedAt: generatedAt || new Date().toISOString()
  };
}

function buildReport({ archives, rawRecords, normalizedRecords, normalizedDates, missingNormalizedDates, aliases }) {
  const closedWithObservedWait = normalizedRecords.filter((row) => !row.isOpen && row.observedWaitTimeMinutes !== null).length;
  const invalidTimezones = rawRecords.filter((row) => row.snapshotTimezone !== "America/Los_Angeles").length;
  if (closedWithObservedWait || invalidTimezones) throw new Error("Backfill violates normalized wait or timezone invariants");
  return {
    rawArchiveCount: archives.length,
    rawObservationCount: rawRecords.length,
    normalizedObservationCount: normalizedRecords.length,
    normalizedDates,
    missingNormalizedDates,
    aliasCount: aliases.length,
    singleRiderCount: normalizedRecords.filter((row) => row.accessMode === "single_rider").length,
    standbyAnalysisCount: normalizedRecords.filter(
      (row) => row.accessMode === "standby" && row.isOpen && row.observedWaitTimeMinutes !== null && row.trainingEligibility === "standby_wait_model"
    ).length,
    closedWithObservedWait,
    invalidTimezones
  };
}

function validateRawRows(rows, filename) {
  const required = ["snapshot_utc", "snapshot_park_date", "snapshot_timezone", "park_id", "ride_id", "ride_name", "is_open", "source_last_updated_utc", "source_url"];
  if (!rows.length) throw new Error(`${filename} contains no observations`);
  for (const [index, row] of rows.entries()) {
    for (const key of required) if (!row[key]) throw new Error(`${filename}:${index + 2} is missing ${key}`);
    if (row.snapshot_timezone !== "America/Los_Angeles") throw new Error(`${filename}:${index + 2} has unsupported timezone ${row.snapshot_timezone}`);
  }
}

function sourceIdentity(row) {
  return [
    row.snapshotUtc ?? row.snapshot_utc,
    row.parkId ?? row.park_id,
    row.rideId ?? row.ride_id,
    row.rideName ?? row.ride_name,
    row.sourceLastUpdatedUtc ?? row.source_last_updated_utc,
    row.sourceUrl ?? row.source_url
  ].join("\u001f");
}

function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const value = key(row);
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(row);
  }
  return groups;
}

function normalizeAccessMode(value) {
  return ["standby", "single_rider", "virtual_queue"].includes(value) ? value : "other";
}

function parseBoolean(value) {
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  throw new Error(`Invalid boolean: ${value}`);
}

function parseNullableNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`Invalid non-negative number: ${value}`);
  return number;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
