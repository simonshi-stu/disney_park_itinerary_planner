import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const rawDir = path.join(rootDir, "data", "wait_times");
const processedDir = path.join(rootDir, "data", "processed", "wait_times");
const reportsDir = path.join(rootDir, "outputs", "quality_reports");
const csvBom = "\uFEFF";
const parkTimezone = "America/Los_Angeles";
const staleMinutes = Number(getArgValue("--stale-minutes") || 60);
const fullDayClosedRatio = Number(getArgValue("--full-day-closed-ratio") || 0.9);
const noWrite = process.argv.includes("--no-write");
const requestedDate = getArgValue("--date");

const parks = [
  {
    id: "disneyland",
    name: "Disneyland",
    schedulePath: path.join(rootDir, "src", "cache", "themeparks", "disneyland.schedule.json")
  },
  {
    id: "dca",
    name: "Disney California Adventure",
    schedulePath: path.join(rootDir, "src", "cache", "themeparks", "dca.schedule.json")
  }
];

const rawHeader = [
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

const cleanedHeader = [
  ...rawHeader,
  "normalized_ride_name",
  "base_ride_name",
  "is_single_rider",
  "is_likely_entertainment",
  "source_age_minutes",
  "observed_wait_time_minutes",
  "quality_flags",
  "training_eligibility"
];

const scheduleByPark = await loadParkSchedules();
const csvFiles = await findCsvFiles();

if (!csvFiles.length) {
  console.log("No wait-time CSV files found.");
  process.exit(0);
}

if (!noWrite) {
  await mkdir(processedDir, { recursive: true });
  await mkdir(reportsDir, { recursive: true });
}

const reports = [];

for (const csvFile of csvFiles) {
  const report = await analyzeCsvFile(csvFile);
  reports.push(report);

  if (!noWrite) {
    const cleanedPath = path.join(processedDir, `wait_times_cleaned_${report.date}.csv`);
    const jsonPath = path.join(reportsDir, `${report.date}.json`);
    const markdownPath = path.join(reportsDir, `${report.date}.md`);

    await writeCsv(cleanedPath, cleanedHeader, report.cleanedRows);
    await writeFile(jsonPath, `${JSON.stringify(withoutCleanedRows(report), null, 2)}\n`, "utf8");
    await writeFile(markdownPath, renderMarkdown(report), "utf8");
  }

  console.log(
    [
      `${report.date}: rows=${report.summary.totalRows}`,
      `snapshots=${report.summary.snapshotCount}`,
      `closed=${report.summary.closedRows}`,
      `zero=${report.summary.zeroWaitRows}`,
      `stale=${report.summary.staleRows}`,
      `duplicates=${report.duplicateGroups.length}`,
      `singleRiderUsable=${report.singleRiderSummary.optimizerUsableGroups}`
    ].join(" ")
  );
}

if (!noWrite && reports.length) {
  const latest = reports.at(-1);
  await writeFile(path.join(reportsDir, "latest.json"), `${JSON.stringify(withoutCleanedRows(latest), null, 2)}\n`, "utf8");
  await writeFile(path.join(reportsDir, "latest.md"), renderMarkdown(latest), "utf8");
}

async function analyzeCsvFile(csvFile) {
  const rawRows = await readCsv(csvFile.path);
  const date = csvFile.date;
  const rows = rawRows.map((row, index) => normalizeRow(row, index));
  const rideProfiles = buildRideProfiles(rows);
  const singleRiderProfiles = buildSingleRiderProfiles(rows);
  const duplicateGroups = findDuplicateGroups(rows);
  const snapshotSummary = buildSnapshotSummary(rows);
  const collectionWindowSummary = buildCollectionWindowSummary(rows, date);
  const cleanedRows = rows.map((row) => cleanRow(row, rideProfiles, singleRiderProfiles));
  const summary = buildSummary(rows, cleanedRows);

  return {
    generatedAt: new Date().toISOString(),
    sourceFile: path.relative(rootDir, csvFile.path).replace(/\\/g, "/"),
    date,
    thresholds: {
      staleMinutes,
      fullDayClosedRatio
    },
    summary,
    byPark: buildParkSummary(rows),
    snapshotSummary,
    collectionWindowSummary,
    singleRiderSummary: summarizeSingleRiders(singleRiderProfiles),
    rideQualitySummary: summarizeRideProfiles(rideProfiles),
    duplicateGroups,
    staleSources: summarizeStaleSources(rows),
    recommendations: buildRecommendations(rows, duplicateGroups, singleRiderProfiles),
    cleanedRows
  };
}

function normalizeRow(row, index) {
  const waitTime = Number(row.wait_time_minutes);
  const isOpen = String(row.is_open || "").toUpperCase() === "TRUE";
  const sourceAgeMinutes = getSourceAgeMinutes(row.snapshot_utc, row.source_last_updated_utc);
  const normalizedRideName = normalizeName(row.ride_name);
  const baseRideName = removeSingleRiderSuffix(row.ride_name);
  const normalizedBaseRideName = normalizeName(baseRideName);
  const isSingleRider = /\bsingle\s+rider\b/i.test(String(row.ride_name || ""));
  const isLikelyEntertainment = isLikelyEntertainmentName(row.ride_name);

  return {
    ...row,
    index,
    waitTime: Number.isFinite(waitTime) ? waitTime : null,
    isOpen,
    sourceAgeMinutes,
    normalizedRideName,
    baseRideName,
    normalizedBaseRideName,
    isSingleRider,
    isLikelyEntertainment,
    snapshotTime: parseDate(row.snapshot_utc),
    rideKey: getRideKey(row, normalizedRideName)
  };
}

function cleanRow(row, rideProfiles, singleRiderProfiles) {
  const flags = [];
  const profile = rideProfiles.get(row.rideKey);
  const singleRiderProfile = singleRiderProfiles.get(getSingleRiderKey(row));

  if (!row.isOpen) flags.push("closed");
  if (row.isOpen && row.waitTime === 0) flags.push("open_zero");
  if (row.sourceAgeMinutes !== null && row.sourceAgeMinutes > staleMinutes) flags.push("stale_source");
  if (row.isSingleRider) flags.push("single_rider");
  if (row.isLikelyEntertainment) flags.push("likely_entertainment");
  if (profile?.possibleFullDayClosed) flags.push("possible_full_day_closed");
  if (profile?.temporaryDowntime) flags.push("temporary_downtime");
  if (row.isSingleRider && singleRiderProfile?.allObservedWaitsZero) flags.push("single_rider_all_zero");

  const observedWaitTime = row.isOpen && Number.isFinite(row.waitTime) ? row.waitTime : "";
  const trainingEligibility = getTrainingEligibility(row, flags, singleRiderProfile);

  return {
    snapshot_utc: row.snapshot_utc,
    snapshot_park_datetime: row.snapshot_park_datetime,
    snapshot_park_date: row.snapshot_park_date,
    snapshot_timezone: row.snapshot_timezone,
    park_id: row.park_id,
    park_name: row.park_name,
    land: row.land,
    ride_id: row.ride_id,
    ride_name: row.ride_name,
    is_open: row.is_open,
    wait_time_minutes: row.wait_time_minutes,
    source_last_updated_utc: row.source_last_updated_utc,
    source_last_updated_park_datetime: row.source_last_updated_park_datetime,
    source_url: row.source_url,
    normalized_ride_name: row.normalizedRideName,
    base_ride_name: row.baseRideName,
    is_single_rider: row.isSingleRider ? "TRUE" : "FALSE",
    is_likely_entertainment: row.isLikelyEntertainment ? "TRUE" : "FALSE",
    source_age_minutes: row.sourceAgeMinutes === null ? "" : row.sourceAgeMinutes.toFixed(1),
    observed_wait_time_minutes: observedWaitTime,
    quality_flags: flags.join("|"),
    training_eligibility: trainingEligibility
  };
}

function getTrainingEligibility(row, flags, singleRiderProfile) {
  if (flags.includes("stale_source")) return "exclude_stale_source";
  if (row.isLikelyEntertainment) return "schedule_constraint_only";
  if (row.isSingleRider) {
    return singleRiderProfile && !singleRiderProfile.allObservedWaitsZero
      ? "single_rider_optimizer_reference"
      : "single_rider_availability_only";
  }
  if (!row.isOpen) return "status_model_only";
  if (!Number.isFinite(row.waitTime)) return "exclude_missing_wait";
  return "standby_wait_model";
}

function buildRideProfiles(rows) {
  const grouped = groupBy(rows, (row) => row.rideKey);
  const profiles = new Map();

  for (const [key, group] of grouped) {
    const sorted = [...group].sort((a, b) => a.snapshotTime - b.snapshotTime);
    const closedRows = sorted.filter((row) => !row.isOpen).length;
    const openRows = sorted.length - closedRows;
    const transitions = countStateTransitions(sorted.map((row) => row.isOpen));
    const possibleFullDayClosed = sorted.length > 0 && closedRows / sorted.length >= fullDayClosedRatio;
    const temporaryDowntime = openRows > 0 && closedRows > 0 && transitions >= 2;

    profiles.set(key, {
      key,
      parkId: sorted[0]?.park_id || "",
      rideId: sorted[0]?.ride_id || "",
      rideName: sorted[0]?.ride_name || "",
      normalizedRideName: sorted[0]?.normalizedRideName || "",
      totalRows: sorted.length,
      openRows,
      closedRows,
      closedRatio: sorted.length ? round(closedRows / sorted.length, 3) : 0,
      transitions,
      possibleFullDayClosed,
      temporaryDowntime
    });
  }

  return profiles;
}

function buildSingleRiderProfiles(rows) {
  const singleRows = rows.filter((row) => row.isSingleRider);
  const grouped = groupBy(singleRows, getSingleRiderKey);
  const profiles = new Map();

  for (const [key, group] of grouped) {
    const waits = group.map((row) => row.waitTime).filter(Number.isFinite);
    const positiveWaitRows = group.filter((row) => row.isOpen && Number.isFinite(row.waitTime) && row.waitTime > 0).length;
    const zeroWaitRows = group.filter((row) => Number.isFinite(row.waitTime) && row.waitTime === 0).length;
    const allObservedWaitsZero = waits.length > 0 && positiveWaitRows === 0;

    profiles.set(key, {
      key,
      parkId: group[0]?.park_id || "",
      baseRideName: group[0]?.baseRideName || "",
      totalRows: group.length,
      openRows: group.filter((row) => row.isOpen).length,
      closedRows: group.filter((row) => !row.isOpen).length,
      zeroWaitRows,
      positiveWaitRows,
      allObservedWaitsZero,
      optimizerUse: positiveWaitRows > 0 ? "use_wait_reference" : "availability_only"
    });
  }

  return profiles;
}

function findDuplicateGroups(rows) {
  const grouped = groupBy(rows, (row) => `${row.snapshot_utc}|${row.park_id}|${row.normalizedRideName}`);
  return Array.from(grouped.values())
    .filter((group) => group.length > 1)
    .map((group) => ({
      snapshotUtc: group[0].snapshot_utc,
      snapshotParkDatetime: group[0].snapshot_park_datetime,
      parkId: group[0].park_id,
      normalizedRideName: group[0].normalizedRideName,
      rowCount: group.length,
      rides: group.map((row) => ({
        rideId: row.ride_id,
        rideName: row.ride_name,
        isOpen: row.is_open,
        waitTimeMinutes: row.wait_time_minutes
      }))
    }));
}

function buildSummary(rows, cleanedRows) {
  return {
    totalRows: rows.length,
    snapshotCount: new Set(rows.map((row) => row.snapshot_utc)).size,
    rideCount: new Set(rows.map((row) => row.rideKey)).size,
    closedRows: rows.filter((row) => !row.isOpen).length,
    zeroWaitRows: rows.filter((row) => row.waitTime === 0).length,
    openZeroRows: rows.filter((row) => row.isOpen && row.waitTime === 0).length,
    staleRows: rows.filter((row) => row.sourceAgeMinutes !== null && row.sourceAgeMinutes > staleMinutes).length,
    singleRiderRows: rows.filter((row) => row.isSingleRider).length,
    likelyEntertainmentRows: rows.filter((row) => row.isLikelyEntertainment).length,
    standbyWaitModelRows: cleanedRows.filter((row) => row.training_eligibility === "standby_wait_model").length,
    statusModelOnlyRows: cleanedRows.filter((row) => row.training_eligibility === "status_model_only").length
  };
}

function buildParkSummary(rows) {
  return Object.fromEntries(
    Array.from(groupBy(rows, (row) => row.park_id).entries()).map(([parkId, group]) => [
      parkId,
      {
        rows: group.length,
        snapshots: new Set(group.map((row) => row.snapshot_utc)).size,
        closedRows: group.filter((row) => !row.isOpen).length,
        zeroWaitRows: group.filter((row) => row.waitTime === 0).length,
        openZeroRows: group.filter((row) => row.isOpen && row.waitTime === 0).length,
        staleRows: group.filter((row) => row.sourceAgeMinutes !== null && row.sourceAgeMinutes > staleMinutes).length
      }
    ])
  );
}

function buildSnapshotSummary(rows) {
  return Array.from(groupBy(rows, (row) => row.snapshot_park_datetime).entries()).map(([snapshotParkDatetime, group]) => ({
    snapshotParkDatetime,
    snapshotUtc: group[0]?.snapshot_utc || "",
    totalRows: group.length,
    parks: Object.fromEntries(
      Array.from(groupBy(group, (row) => row.park_id).entries()).map(([parkId, parkRows]) => [
        parkId,
        {
          rows: parkRows.length,
          closedRows: parkRows.filter((row) => !row.isOpen).length,
          zeroWaitRows: parkRows.filter((row) => row.waitTime === 0).length
        }
      ])
    )
  }));
}

function buildCollectionWindowSummary(rows, date) {
  const snapshots = Array.from(groupBy(rows, (row) => row.snapshot_utc).entries())
    .map(([snapshotUtc, group]) => ({
      snapshotUtc,
      snapshotParkDatetime: group[0]?.snapshot_park_datetime || "",
      presentParks: new Set(group.map((row) => row.park_id))
    }))
    .sort((a, b) => parseDate(a.snapshotUtc) - parseDate(b.snapshotUtc));

  const checks = [];

  for (const snapshot of snapshots) {
    const snapshotTime = parseDate(snapshot.snapshotUtc);
    for (const park of parks) {
      const window = getScheduleWindow(park.id, date, snapshotTime);
      checks.push({
        snapshotUtc: snapshot.snapshotUtc,
        snapshotParkDatetime: snapshot.snapshotParkDatetime,
        parkId: park.id,
        expectedInsideCollectionWindow: window.shouldCollect,
        rowsPresent: snapshot.presentParks.has(park.id),
        openingTime: window.openingTime,
        closingTime: window.closingTime
      });
    }
  }

  return {
    missingExpectedParkSnapshots: checks.filter((check) => check.expectedInsideCollectionWindow && !check.rowsPresent),
    unexpectedParkSnapshots: checks.filter((check) => !check.expectedInsideCollectionWindow && check.rowsPresent),
    checks: checks.slice(-30)
  };
}

function getScheduleWindow(parkId, date, snapshotTime) {
  const entries = scheduleByPark.get(parkId) || [];
  const entry = entries.find((candidate) => candidate.date === date);

  if (!entry) {
    return {
      shouldCollect: true,
      openingTime: "",
      closingTime: ""
    };
  }

  const startsAt = entry.open.getTime() - 30 * 60000;
  const endsAt = entry.close.getTime() + 60 * 60000;
  return {
    shouldCollect: snapshotTime.getTime() >= startsAt && snapshotTime.getTime() <= endsAt,
    openingTime: entry.openingTime,
    closingTime: entry.closingTime
  };
}

function summarizeSingleRiders(singleRiderProfiles) {
  const profiles = Array.from(singleRiderProfiles.values()).sort((a, b) => a.key.localeCompare(b.key));
  return {
    groups: profiles.length,
    optimizerUsableGroups: profiles.filter((profile) => profile.optimizerUse === "use_wait_reference").length,
    availabilityOnlyGroups: profiles.filter((profile) => profile.optimizerUse === "availability_only").length,
    profiles
  };
}

function summarizeRideProfiles(rideProfiles) {
  const profiles = Array.from(rideProfiles.values());
  return {
    possibleFullDayClosed: profiles
      .filter((profile) => profile.possibleFullDayClosed)
      .map(pickRideProfileFields)
      .sort((a, b) => b.closedRatio - a.closedRatio),
    temporaryDowntime: profiles
      .filter((profile) => profile.temporaryDowntime)
      .map(pickRideProfileFields)
      .sort((a, b) => b.transitions - a.transitions)
  };
}

function summarizeStaleSources(rows) {
  const staleRows = rows.filter((row) => row.sourceAgeMinutes !== null && row.sourceAgeMinutes > staleMinutes);
  const grouped = groupBy(staleRows, (row) => `${row.park_id}|${row.ride_name}`);

  return Array.from(grouped.entries())
    .map(([key, group]) => {
      const [parkId, rideName] = key.split("|");
      return {
        parkId,
        rideName,
        rows: group.length,
        maxSourceAgeMinutes: round(Math.max(...group.map((row) => row.sourceAgeMinutes)), 1)
      };
    })
    .sort((a, b) => b.maxSourceAgeMinutes - a.maxSourceAgeMinutes);
}

function buildRecommendations(rows, duplicateGroups, singleRiderProfiles) {
  const recommendations = [];
  const staleCount = rows.filter((row) => row.sourceAgeMinutes !== null && row.sourceAgeMinutes > staleMinutes).length;
  const singleRiderAvailabilityOnly = Array.from(singleRiderProfiles.values()).filter(
    (profile) => profile.optimizerUse === "availability_only"
  ).length;

  if (staleCount) {
    recommendations.push("Exclude stale_source rows from wait-time training until the source timestamp becomes fresh again.");
  }
  if (duplicateGroups.length) {
    recommendations.push("Add duplicate ride names to the future canonical attraction mapping review list.");
  }
  if (singleRiderAvailabilityOnly) {
    recommendations.push("Keep Single Rider availability, but do not use all-zero Single Rider waits as optimizer wait-time weights.");
  }
  recommendations.push("Use observed_wait_time_minutes as the modeling target; raw wait_time_minutes remains available for audits.");

  return recommendations;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push(`# Wait-Time Quality Report: ${report.date}`);
  lines.push("");
  lines.push(`Generated at: ${report.generatedAt}`);
  lines.push(`Source file: ${report.sourceFile}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Rows: ${report.summary.totalRows}`);
  lines.push(`- Snapshots: ${report.summary.snapshotCount}`);
  lines.push(`- Rides: ${report.summary.rideCount}`);
  lines.push(`- Closed rows: ${report.summary.closedRows}`);
  lines.push(`- Zero wait rows: ${report.summary.zeroWaitRows}`);
  lines.push(`- Open zero rows: ${report.summary.openZeroRows}`);
  lines.push(`- Stale rows: ${report.summary.staleRows}`);
  lines.push(`- Standby wait model rows: ${report.summary.standbyWaitModelRows}`);
  lines.push("");
  lines.push("## By Park");
  lines.push("");
  lines.push("| Park | Rows | Snapshots | Closed | Zero | Open Zero | Stale |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const [parkId, summary] of Object.entries(report.byPark)) {
    lines.push(
      `| ${parkId} | ${summary.rows} | ${summary.snapshots} | ${summary.closedRows} | ${summary.zeroWaitRows} | ${summary.openZeroRows} | ${summary.staleRows} |`
    );
  }
  lines.push("");
  lines.push("## Single Rider");
  lines.push("");
  lines.push(`- Groups: ${report.singleRiderSummary.groups}`);
  lines.push(`- Optimizer usable groups: ${report.singleRiderSummary.optimizerUsableGroups}`);
  lines.push(`- Availability-only groups: ${report.singleRiderSummary.availabilityOnlyGroups}`);
  lines.push("");
  lines.push("| Park | Base ride | Rows | Open | Positive waits | Zero waits | Optimizer use |");
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | --- |");
  for (const profile of report.singleRiderSummary.profiles) {
    lines.push(
      `| ${profile.parkId} | ${profile.baseRideName} | ${profile.totalRows} | ${profile.openRows} | ${profile.positiveWaitRows} | ${profile.zeroWaitRows} | ${profile.optimizerUse} |`
    );
  }
  lines.push("");
  lines.push("## Data Issues");
  lines.push("");
  lines.push(`- Duplicate snapshot/name groups: ${report.duplicateGroups.length}`);
  lines.push(`- Stale source groups: ${report.staleSources.length}`);
  lines.push(`- Possible full-day closed rides: ${report.rideQualitySummary.possibleFullDayClosed.length}`);
  lines.push(`- Temporary downtime candidates: ${report.rideQualitySummary.temporaryDowntime.length}`);
  lines.push(
    `- Missing expected park snapshots: ${report.collectionWindowSummary.missingExpectedParkSnapshots.length}`
  );
  lines.push(
    `- Unexpected park snapshots: ${report.collectionWindowSummary.unexpectedParkSnapshots.length}`
  );
  lines.push("");
  lines.push("## Recommendations");
  lines.push("");
  for (const recommendation of report.recommendations) {
    lines.push(`- ${recommendation}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function withoutCleanedRows(report) {
  const { cleanedRows, ...rest } = report;
  return rest;
}

async function findCsvFiles() {
  const filenames = await readdir(rawDir);
  return filenames
    .map((filename) => {
      const match = filename.match(/^wait_times_(\d{4}-\d{2}-\d{2})\.csv$/);
      if (!match) return null;
      if (requestedDate && match[1] !== requestedDate) return null;
      return {
        date: match[1],
        path: path.join(rawDir, filename)
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function readCsv(filePath) {
  const text = stripBom(await readFile(filePath, "utf8")).trimEnd();
  if (!text) return [];
  const records = parseCsv(text);
  const header = records.shift() || [];
  return records
    .filter((record) => record.some((value) => value !== ""))
    .map((record) => Object.fromEntries(header.map((key, index) => [key, record[index] ?? ""])));
}

async function writeCsv(filePath, header, rows) {
  const csv = [header.join(","), ...rows.map((row) => header.map((key) => csvEscape(row[key])).join(","))].join("\n");
  await writeFile(filePath, `${csvBom}${csv}\n`, "utf8");
}

async function loadParkSchedules() {
  const schedules = new Map();

  for (const park of parks) {
    try {
      const data = JSON.parse(await readFile(park.schedulePath, "utf8"));
      const entries = (Array.isArray(data.schedule) ? data.schedule : [])
        .map((entry) => ({
          date: entry.date || getDateInZone(entry.openingTime, parkTimezone),
          openingTime: entry.openingTime || "",
          closingTime: entry.closingTime || "",
          open: parseDate(entry.openingTime),
          close: parseDate(entry.closingTime)
        }))
        .filter((entry) => entry.date && !Number.isNaN(entry.open.getTime()) && !Number.isNaN(entry.close.getTime()));
      schedules.set(park.id, entries);
    } catch {
      schedules.set(park.id, []);
    }
  }

  return schedules;
}

function pickRideProfileFields(profile) {
  return {
    parkId: profile.parkId,
    rideId: profile.rideId,
    rideName: profile.rideName,
    totalRows: profile.totalRows,
    openRows: profile.openRows,
    closedRows: profile.closedRows,
    closedRatio: profile.closedRatio,
    transitions: profile.transitions
  };
}

function getRideKey(row, normalizedRideName) {
  return `${row.park_id}|${row.ride_id || normalizedRideName}`;
}

function getSingleRiderKey(row) {
  return `${row.park_id}|${row.normalizedBaseRideName}`;
}

function getSourceAgeMinutes(snapshotUtc, sourceLastUpdatedUtc) {
  const snapshot = parseDate(snapshotUtc);
  const source = parseDate(sourceLastUpdatedUtc);
  if (Number.isNaN(snapshot.getTime()) || Number.isNaN(source.getTime())) return null;
  return (snapshot.getTime() - source.getTime()) / 60000;
}

function countStateTransitions(states) {
  let transitions = 0;
  for (let index = 1; index < states.length; index += 1) {
    if (states[index] !== states[index - 1]) transitions += 1;
  }
  return transitions;
}

function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[™®©]/g, "")
    .replace(/[鈩甝擼]/g, "")
    .replace(/[’‘`]/g, "'")
    .replace(/[“”"]/g, "")
    .replace(/[–—]/g, "-")
    .replace(/\s*&\s*/g, " and ")
    .replace(/\bsingle\s+rider\b/g, "")
    .replace(/[^a-z0-9'\- ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function removeSingleRiderSuffix(name) {
  return String(name || "").replace(/\s*single\s+rider\s*/i, "").trim();
}

function isLikelyEntertainmentName(name) {
  return /\b(world of color|fireworks|parade|nighttime spectacular|magic happens|fantasmic)\b/i.test(String(name || ""));
}

function groupBy(items, getKey) {
  const grouped = new Map();
  for (const item of items) {
    const key = getKey(item);
    const group = grouped.get(key) || [];
    group.push(item);
    grouped.set(key, group);
  }
  return grouped;
}

function parseDate(value) {
  if (!value) return new Date(Number.NaN);
  return new Date(value);
}

function getDateInZone(value, timezone) {
  const date = parseDate(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function getArgValue(name) {
  const prefix = `${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
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
