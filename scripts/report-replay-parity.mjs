import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBackfillPlan } from "../infra/backfill/wait-time-records.mjs";

export const parityContractVersion = "replay-parity.v1";
export const parityDiagnosticSampleLimit = 20;
const dateDiagnosticSampleLimit = 5;
const failureDiagnosticSampleLimit = 40;

/**
 * Compare a file replay plan with a read-only database snapshot.
 *
 * The comparison is deliberately keyed by immutable raw observation IDs and
 * transformation versions. It does not compare cleaned CSV bytes because the
 * target normalizer is allowed to change representation while preserving raw
 * lineage and the governed semantics.
 */
export function buildReplayParityReport(input, positionalDatabaseSnapshot, positionalOptions = {}) {
  const positional = input && !input.plan && input.rawRecords;
  const {
    plan,
    databaseSnapshot,
    operatingWindows = [],
    generatedAt = new Date().toISOString(),
    runId = randomUUID(),
    databaseError = null
  } = positional
    ? {
        plan: {
          rawRecords: input.rawRecords,
          normalizedRecords: input.normalizedRecords || [],
          archives: input.archives || []
        },
        databaseSnapshot: positionalDatabaseSnapshot,
        operatingWindows: input.operatingWindows || positionalDatabaseSnapshot?.operatingWindows || positionalOptions.operatingWindows || [],
        generatedAt: positionalOptions.generatedAt,
        runId: positionalOptions.runId,
        databaseError: positionalOptions.databaseError
      }
    : input;
  const fileSnapshot = summarizeSnapshot(plan);
  if (fileSnapshot.dates.length === 0) {
    return {
      contract_version: parityContractVersion,
      run_id: runId,
      checked_at: generatedAt,
      status: "blocked",
      failure_count: 1,
      counts: { file: fileSnapshot.counts, database: databaseSnapshot ? summarizeSnapshot(databaseSnapshot).counts : null },
      diagnostic_sample_limit: parityDiagnosticSampleLimit,
      dates: [],
      excluded_dates: [],
      training_eligible_dates: [],
      checks: {},
      failures: [{ type: "file_input_empty", detail: "no raw observations were supplied" }],
      next_steps: ["Provide at least one raw archive and rerun replay parity."]
    };
  }
  if (!databaseSnapshot) {
    const message = databaseError || "database snapshot was not supplied";
    return {
      contract_version: parityContractVersion,
      run_id: runId,
      checked_at: generatedAt,
      status: "blocked",
      failure_count: 1,
      counts: {
        file: fileSnapshot.counts,
        database: null
      },
      diagnostic_sample_limit: parityDiagnosticSampleLimit,
      dates: fileSnapshot.dates.map((date) => ({
        date,
        status: "excluded",
        mismatch_count: 1,
        mismatches: [{ type: "database_unavailable", expected: "read_only_snapshot", actual: message }]
      })),
      excluded_dates: fileSnapshot.dates,
      training_eligible_dates: [],
      checks: {
        counts: failedCheck([{ type: "database_unavailable", detail: message }], fileSnapshot.dates.length),
        hashes: unverifiedCheck(),
        closed_zero_semantics: unverifiedCheck(),
        lineage: unverifiedCheck(),
        canonical_identity: unverifiedCheck(),
        operating_window_coverage: unverifiedCheck()
      },
      failures: [{ type: "database_unavailable", detail: message }],
      next_steps: [
        "Provide a read-only DATABASE_URL and raw archive storage, then rerun parity.",
        "Keep every excluded date out of forecast training until a subsequent parity report passes."
      ]
    };
  }

  const database = summarizeSnapshot(databaseSnapshot);
  const expectedByDate = mapByDate(plan, fileSnapshot);
  const actualByDate = mapByDate(databaseSnapshot, database);
  const countCheckCollector = createMismatchCollector();
  addDateValueMismatches(countCheckCollector, expectedByDate, actualByDate, ["raw_count", "normalized_count"]);
  if (fileSnapshot.counts.raw_archives !== database.counts.raw_archives) {
    const mismatch = {
      type: "raw_archive_count",
      expected: fileSnapshot.counts.raw_archives,
      actual: database.counts.raw_archives
    };
    countCheckCollector.add(mismatch, differenceMagnitude(mismatch.expected, mismatch.actual));
  }
  const countCheck = countCheckCollector.finish();
  const checks = {
    counts: countCheck,
    hashes: compareDateValues(expectedByDate, actualByDate, "archive_hashes"),
    closed_zero_semantics: compareDateValues(
      expectedByDate,
      actualByDate,
      "raw_closed_zero_count",
      "raw_open_zero_count",
      "raw_open_missing_count",
      "normalized_closed_wait_count",
      "normalized_open_zero_count",
      "normalized_open_missing_count"
    ),
    lineage: compareLineage(plan, databaseSnapshot),
    canonical_identity: compareCanonicalIdentity(plan, databaseSnapshot),
    operating_window_coverage: compareOperatingCoverage(
      expectedByDate,
      actualByDate,
      operatingWindows
    )
  };

  const dateMismatchCounts = new Map();
  const dateMismatchSamples = new Map();
  const globalMismatchSamples = [];
  let globalMismatchCount = 0;
  for (const check of Object.values(checks)) {
    for (const [date, count] of check._dateCounts) {
      dateMismatchCounts.set(date, (dateMismatchCounts.get(date) || 0) + count);
      const samples = dateMismatchSamples.get(date) || [];
      for (const mismatch of check._dateSamples.get(date) || []) {
        if (samples.length >= dateDiagnosticSampleLimit) break;
        samples.push(mismatch);
      }
      dateMismatchSamples.set(date, samples);
    }
    globalMismatchCount += check._globalCount;
    for (const mismatch of check._globalSamples) {
      if (globalMismatchSamples.length >= dateDiagnosticSampleLimit) break;
      globalMismatchSamples.push(mismatch);
    }
  }
  const allDates = [...new Set([...fileSnapshot.dates, ...database.dates])].sort();
  const fileDateSet = new Set(fileSnapshot.dates);
  const dates = allDates.map((date) => ({
    date,
    status: (dateMismatchCounts.get(date) || 0) > 0 || (fileDateSet.has(date) && globalMismatchCount > 0) ? "excluded" : "eligible",
    mismatch_count: (dateMismatchCounts.get(date) || 0) + (fileDateSet.has(date) ? globalMismatchCount : 0),
    mismatches: [
      ...(fileDateSet.has(date) ? globalMismatchSamples : []),
      ...(dateMismatchSamples.get(date) || [])
    ].slice(0, dateDiagnosticSampleLimit),
    file: buildDateDetail(fileSnapshot.byDate.get(date), plan, date, operatingWindows),
    database: buildDateDetail(database.byDate.get(date), databaseSnapshot, date, operatingWindows)
  }));
  const excludedDates = dates.filter((entry) => entry.status === "excluded").map((entry) => entry.date);
  const failures = [];
  let totalMismatchCount = 0;
  let totalDifferenceCount = 0;
  for (const [name, check] of Object.entries(checks)) {
    if (check.passed) continue;
    totalMismatchCount += check.mismatch_count;
    totalDifferenceCount += check.difference_count;
    for (const detail of check.mismatches) {
      if (failures.length >= failureDiagnosticSampleLimit) break;
      failures.push({
        check: name,
        code: failureCode(name, detail.type),
        ...detail
      });
    }
  }
  if (totalMismatchCount > failures.length) {
    failures.push({
      type: "additional_parity_mismatches_omitted",
      mismatch_count: totalMismatchCount,
      difference_count: totalDifferenceCount,
      omitted_mismatch_count: totalMismatchCount - failures.length,
      sample_limit: failureDiagnosticSampleLimit
    });
  }
  const checkSummaries = Object.fromEntries(Object.entries(checks).map(([name, check]) => [name, publicCheckSummary(check)]));
  const blocked = Object.values(checks).some((check) => !check.passed);

  return {
    contract_version: parityContractVersion,
    run_id: runId,
    checked_at: generatedAt,
    status: blocked ? "blocked" : "passed",
    failure_count: totalMismatchCount,
    diagnostic_sample_limit: parityDiagnosticSampleLimit,
    counts: {
      file: fileSnapshot.counts,
      database: database.counts
    },
    dates,
    excluded_dates: excludedDates,
    training_eligible_dates: dates.filter((entry) => entry.status === "eligible").map((entry) => entry.date),
    checks: checkSummaries,
    failures,
    next_steps: failures.length
      ? [
          "Investigate each reported count, hash, semantic, lineage, canonical-identity, or operating-window mismatch.",
          "Do not include excluded dates in forecast training or production backfill decisions.",
          "Rerun this read-only parity report after correcting the source or replay input."
        ]
      : [
          "All compared dates passed replay parity; retain the report with the input snapshot.",
          "Keep GitHub Actions bootstrap collection enabled until dual-run and cutover gates pass."
        ]
  };
}

/** Build a normalized in-memory file snapshot for tests and offline callers. */
export function buildFileParitySnapshot({ rawRecords = [], normalizedRecords = [], archives = [] }, options = {}) {
  return { rawRecords, normalizedRecords, archives, operatingWindows: options.operatingWindows || [] };
}

/** Build a normalized in-memory database snapshot from snake_case query rows. */
export function buildDatabaseParitySnapshot({ rawRows = [], normalizedRows = [], archives = [] }, options = {}) {
  const archiveRows = archives.length
    ? archives
    : [...new Map(rawRows.map((row) => [row.raw_archive_id ?? row.rawArchiveId, {
        rawArchiveId: String(row.raw_archive_id ?? row.rawArchiveId),
        sha256: String(row.sha256 ?? row.archive_sha256 ?? ""),
        sourceName: String(row.source_name ?? row.sourceName ?? "")
      }])).values()];
  return {
    archives: archiveRows,
    rawRecords: rawRows.map((row) => ({
      rawObservationId: String(row.raw_observation_id ?? row.rawObservationId),
      rawArchiveId: String(row.raw_archive_id ?? row.rawArchiveId),
      snapshotParkDate: String(row.snapshot_park_date ?? row.snapshotParkDate),
      snapshotUtc: row.snapshot_utc ?? row.snapshotUtc,
      parkId: String(row.park_id ?? row.parkId),
      rideId: String(row.ride_id ?? row.rideId),
      rideName: String(row.ride_name ?? row.rideName),
      isOpen: toBoolean(row.is_open ?? row.isOpen),
      waitTimeMinutes: toNullableNumber(row.wait_time_minutes ?? row.waitTimeMinutes)
    })),
    normalizedRecords: normalizedRows.map((row) => ({
      normalizedObservationId: String(row.normalized_observation_id ?? row.normalizedObservationId),
      rawObservationId: String(row.raw_observation_id ?? row.rawObservationId),
      canonicalAttractionId: String(row.canonical_attraction_id ?? row.canonicalAttractionId),
      accessMode: String(row.access_mode ?? row.accessMode),
      isOpen: toBoolean(row.is_open ?? row.isOpen),
      observedWaitTimeMinutes: toNullableNumber(row.observed_wait_time_minutes ?? row.observedWaitTimeMinutes),
      transformationVersion: String(row.transformation_version ?? row.transformationVersion)
    })),
    operatingWindows: options.operatingWindows || []
  };
}

/**
 * Compatibility query helper for tests and adapters that expose separate raw
 * and normalized SELECT results. Production CLI uses loadDatabaseSnapshot so
 * the database read remains one consistent left-joined snapshot.
 */
export async function queryDatabaseSnapshot(client, options = {}) {
  const rawResult = await client.query(
    `SELECT raw.raw_observation_id, raw.raw_archive_id, archive.sha256, raw.snapshot_utc,
            raw.snapshot_park_date, raw.park_id, raw.ride_id, raw.ride_name,
            raw.is_open, raw.wait_time_minutes
       FROM ingestion.raw_wait_observations AS raw
       JOIN ingestion.raw_archives AS archive ON archive.raw_archive_id = raw.raw_archive_id
      WHERE raw.snapshot_park_date::text = ANY($1::text[])
      ORDER BY raw.snapshot_park_date, raw.raw_observation_id`,
    [options.dates || []]
  );
  const normalizedResult = await client.query(
    `SELECT normalized.normalized_observation_id, normalized.raw_observation_id,
            normalized.canonical_attraction_id, normalized.access_mode, normalized.is_open,
            normalized.observed_wait_time_minutes, normalized.transformation_version
       FROM observations.normalized_wait_observations AS normalized
       JOIN ingestion.raw_wait_observations AS raw USING (raw_observation_id)
      WHERE raw.snapshot_park_date::text = ANY($1::text[])
      ORDER BY normalized.normalized_observation_id`,
    [options.dates || []]
  );
  return buildDatabaseParitySnapshot(
    { rawRows: rawResult.rows || [], normalizedRows: normalizedResult.rows || [] },
    { operatingWindows: options.operatingWindows || [] }
  );
}

/**
 * Read the minimum database rows needed for parity. The caller owns the
 * transaction; this function issues SELECT only and never runs migrations or
 * writes data.
 */
export async function loadDatabaseSnapshot(client, { archiveIds, transformationVersions }) {
  if (!client || typeof client.query !== "function") throw new TypeError("a database client with query() is required");
  const result = await client.query(
    `SELECT
       raw.raw_observation_id::text AS raw_observation_id,
       raw.raw_archive_id::text AS raw_archive_id,
       raw.snapshot_park_date::text AS snapshot_park_date,
       raw.snapshot_utc,
       raw.park_id,
       raw.ride_id,
       raw.ride_name,
       raw.is_open AS raw_is_open,
       raw.wait_time_minutes AS raw_wait_time_minutes,
       archive.source_name,
       archive.sha256::text AS archive_sha256,
       normalized.normalized_observation_id::text AS normalized_observation_id,
       normalized.raw_observation_id::text AS normalized_raw_observation_id,
       normalized.canonical_attraction_id,
       normalized.access_mode,
       normalized.is_open AS normalized_is_open,
       normalized.observed_wait_time_minutes,
       normalized.transformation_version
     FROM ingestion.raw_wait_observations AS raw
     JOIN ingestion.raw_archives AS archive
       ON archive.raw_archive_id = raw.raw_archive_id
     LEFT JOIN observations.normalized_wait_observations AS normalized
       ON normalized.raw_observation_id = raw.raw_observation_id
      AND normalized.transformation_version = ANY($2::text[])
     WHERE raw.raw_archive_id::text = ANY($1::text[])
     ORDER BY raw.snapshot_park_date, raw.raw_observation_id, normalized.normalized_observation_id`,
    [archiveIds, transformationVersions]
  );

  const rawById = new Map();
  const archives = new Map();
  const normalizedRecords = [];
  for (const row of result.rows || []) {
    const rawId = String(row.raw_observation_id);
    if (!rawById.has(rawId)) {
      rawById.set(rawId, {
        rawObservationId: rawId,
        rawArchiveId: String(row.raw_archive_id),
        snapshotParkDate: String(row.snapshot_park_date),
        snapshotUtc: row.snapshot_utc,
        parkId: String(row.park_id),
        rideId: String(row.ride_id),
        rideName: String(row.ride_name),
        isOpen: toBoolean(row.raw_is_open),
        waitTimeMinutes: toNullableNumber(row.raw_wait_time_minutes)
      });
    }
    const archiveId = String(row.raw_archive_id);
    if (!archives.has(archiveId)) {
      archives.set(archiveId, {
        rawArchiveId: archiveId,
        sha256: String(row.archive_sha256),
        sourceName: String(row.source_name || "")
      });
    }
    if (row.normalized_observation_id) {
      normalizedRecords.push({
        normalizedObservationId: String(row.normalized_observation_id),
        rawObservationId: String(row.normalized_raw_observation_id || rawId),
        canonicalAttractionId: String(row.canonical_attraction_id),
        accessMode: String(row.access_mode),
        isOpen: toBoolean(row.normalized_is_open),
        observedWaitTimeMinutes: toNullableNumber(row.observed_wait_time_minutes),
        transformationVersion: String(row.transformation_version)
      });
    }
  }
  return {
    archives: [...archives.values()],
    rawRecords: [...rawById.values()],
    normalizedRecords
  };
}

export async function loadOperatingWindows(root, options = {}) {
  const sources = [
    ["disneyland", "src/cache/themeparks/disneyland.schedule.json"],
    ["dca", "src/cache/themeparks/dca.schedule.json"]
  ];
  const windows = [];
  for (const [parkId, relativePath] of sources) {
    let payload;
    try {
      payload = JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
    } catch {
      continue;
    }
    for (const entry of Array.isArray(payload.schedule) ? payload.schedule : []) {
      if (entry.type !== "OPERATING") continue;
      if (options.date && entry.date !== options.date) continue;
      windows.push({
        date: String(entry.date),
        parkId,
        openingTime: entry.openingTime,
        closingTime: entry.closingTime
      });
    }
  }
  return windows;
}

function summarizeSnapshot(snapshot) {
  const normalizedByRawId = new Map();
  for (const row of snapshot.normalizedRecords || []) {
    const key = `${row.rawObservationId}\u001f${row.transformationVersion || ""}`;
    normalizedByRawId.set(key, row);
  }
  const rawById = new Map((snapshot.rawRecords || []).map((row) => [row.rawObservationId, row]));
  const dates = [...new Set((snapshot.rawRecords || []).map((row) => String(row.snapshotParkDate)))].sort();
  const byDate = new Map();
  for (const date of dates) {
    const rawRows = (snapshot.rawRecords || []).filter((row) => String(row.snapshotParkDate) === date);
    const rawIds = new Set(rawRows.map((row) => row.rawObservationId));
    const normalizedRows = (snapshot.normalizedRecords || []).filter((row) => rawIds.has(row.rawObservationId));
    byDate.set(date, summarizeDate({ rawRows, normalizedRows, snapshot }));
  }
  return {
    counts: {
      raw_archives: (snapshot.archives || []).length,
      raw_observations: (snapshot.rawRecords || []).length,
      normalized_observations: (snapshot.normalizedRecords || []).length
    },
    dates,
    byDate,
    rawById,
    normalizedByRawId
  };
}

function summarizeDate({ rawRows, normalizedRows, snapshot }) {
  const archiveHashes = [...new Set(
    (snapshot.archives || [])
      .filter((archive) => rawRows.some((row) => row.rawArchiveId === archive.rawArchiveId))
      .map((archive) => String(archive.sha256))
  )].sort();
  const count = (rows, predicate) => rows.filter(predicate).length;
  return {
    rawRows,
    normalizedRows,
    raw_count: rawRows.length,
    normalized_count: normalizedRows.length,
    archive_hashes: archiveHashes,
    raw_closed_zero_count: count(rawRows, (row) => !row.isOpen && row.waitTimeMinutes === 0),
    raw_open_zero_count: count(rawRows, (row) => row.isOpen && row.waitTimeMinutes === 0),
    raw_open_missing_count: count(rawRows, (row) => row.isOpen && row.waitTimeMinutes === null),
    normalized_closed_wait_count: count(normalizedRows, (row) => !row.isOpen && row.observedWaitTimeMinutes !== null),
    normalized_open_zero_count: count(normalizedRows, (row) => row.isOpen && row.observedWaitTimeMinutes === 0),
    normalized_open_missing_count: count(normalizedRows, (row) => row.isOpen && row.observedWaitTimeMinutes === null)
  };
}

function mapByDate(snapshot, summary) {
  return summary.byDate;
}

function createMismatchCollector() {
  let mismatchCount = 0;
  let differenceCount = 0;
  const mismatches = [];
  const dateCounts = new Map();
  const dateSamples = new Map();
  const globalSamples = [];
  let globalCount = 0;

  return {
    add(mismatch, differences = 1) {
      mismatchCount += 1;
      differenceCount += Math.max(1, Number(differences) || 1);
      if (mismatches.length < parityDiagnosticSampleLimit) mismatches.push(mismatch);
      const date = mismatch.date === null || mismatch.date === undefined ? null : String(mismatch.date);
      if (date === null) {
        globalCount += 1;
        if (globalSamples.length < dateDiagnosticSampleLimit) globalSamples.push(mismatch);
      } else {
        dateCounts.set(date, (dateCounts.get(date) || 0) + 1);
        const samples = dateSamples.get(date) || [];
        if (samples.length < dateDiagnosticSampleLimit) samples.push(mismatch);
        dateSamples.set(date, samples);
      }
    },
    finish() {
      const summary = {
        passed: mismatchCount === 0,
        mismatch_count: mismatchCount,
        difference_count: differenceCount,
        sample_limit: parityDiagnosticSampleLimit,
        sampled_mismatch_count: mismatches.length,
        omitted_mismatch_count: mismatchCount - mismatches.length,
        mismatches
      };
      Object.defineProperties(summary, {
        _dateCounts: { value: dateCounts },
        _dateSamples: { value: dateSamples },
        _globalCount: { value: globalCount },
        _globalSamples: { value: globalSamples }
      });
      return summary;
    }
  };
}

function unverifiedCheck() {
  return { ...createMismatchCollector().finish(), passed: false, verified: false };
}

function failedCheck(mismatches, differences = mismatches.length) {
  const collector = createMismatchCollector();
  for (const mismatch of mismatches) collector.add(mismatch, differences);
  return collector.finish();
}

function publicCheckSummary(check) {
  return {
    passed: check.passed,
    mismatch_count: check.mismatch_count,
    difference_count: check.difference_count,
    sample_limit: check.sample_limit,
    sampled_mismatch_count: check.sampled_mismatch_count,
    omitted_mismatch_count: check.omitted_mismatch_count,
    mismatches: check.mismatches
  };
}

function compareDateValues(expectedByDate, actualByDate, ...fields) {
  const collector = createMismatchCollector();
  addDateValueMismatches(collector, expectedByDate, actualByDate, fields);
  return collector.finish();
}

function addDateValueMismatches(collector, expectedByDate, actualByDate, fields) {
  const dates = [...new Set([...expectedByDate.keys(), ...actualByDate.keys()])].sort();
  for (const date of dates) {
    const expected = expectedByDate.get(date) || {};
    const actual = actualByDate.get(date) || {};
    for (const field of fields) {
      if (!sameValue(expected[field], actual[field])) {
        const expectedValue = expected[field] ?? null;
        const actualValue = actual[field] ?? null;
        const mismatch = { date, type: field };
        if (Array.isArray(expectedValue) || Array.isArray(actualValue)) {
          mismatch.expected = Array.isArray(expectedValue) ? expectedValue.slice(0, parityDiagnosticSampleLimit) : expectedValue;
          mismatch.actual = Array.isArray(actualValue) ? actualValue.slice(0, parityDiagnosticSampleLimit) : actualValue;
          if (Array.isArray(expectedValue)) mismatch.expected_count = expectedValue.length;
          if (Array.isArray(actualValue)) mismatch.actual_count = actualValue.length;
          mismatch.sample_limit = parityDiagnosticSampleLimit;
        } else {
          mismatch.expected = expectedValue;
          mismatch.actual = actualValue;
        }
        collector.add(mismatch, differenceMagnitude(expectedValue, actualValue));
      }
    }
  }
}

function differenceMagnitude(expected, actual) {
  if (typeof expected === "number" && typeof actual === "number") {
    return Math.max(1, Math.abs(expected - actual));
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    const left = new Set(expected || []);
    const right = new Set(actual || []);
    let differences = 0;
    for (const value of left) if (!right.has(value)) differences += 1;
    for (const value of right) if (!left.has(value)) differences += 1;
    return Math.max(1, differences);
  }
  return 1;
}

function buildDateDetail(summary, snapshot, date, operatingWindows) {
  if (!summary) {
    return {
      archive_hashes: [],
      operating_window_coverage: [],
      lineage: { normalized_orphan_count: 0 },
      canonical_identity: {}
    };
  }
  const rawIds = new Set((snapshot?.rawRecords || []).map((row) => row.rawObservationId));
  const orphanCount = (summary.normalizedRows || []).filter((row) => !rawIds.has(row.rawObservationId)).length;
  const canonicalIdentity = {};
  for (const row of summary.normalizedRows || []) {
    const key = String(row.canonicalAttractionId);
    canonicalIdentity[key] = (canonicalIdentity[key] || 0) + 1;
  }
  const coverage = (operatingWindows || [])
    .map(normalizeWindow)
    .filter((window) => window && window.date === date)
    .map((window) => {
      const result = coverageForWindow(summary.rawRows || [], window);
      return {
        park_id: window.parkId,
        observed_snapshot_count: result.observed_snapshot_count,
        inside_window_observation_count: result.in_window_observation_count,
        largest_gap_minutes: result.largest_gap_minutes
      };
    });
  return {
    archive_hashes: summary.archive_hashes,
    operating_window_coverage: coverage,
    lineage: { normalized_orphan_count: orphanCount },
    canonical_identity: canonicalIdentity
  };
}

function failureCode(checkName, mismatchType) {
  if (checkName === "closed_zero_semantics") return "closed_zero_semantics_mismatch";
  if (checkName === "lineage") return "lineage_mismatch";
  if (checkName === "canonical_identity") return "canonical_identity_mismatch";
  if (checkName === "operating_window_coverage") return "operating_window_coverage_mismatch";
  if (checkName === "hashes") return "archive_hash_mismatch";
  if (checkName === "counts") return "count_mismatch";
  return mismatchType || "parity_mismatch";
}

function compareLineage(plan, databaseSnapshot) {
  const expected = new Set((plan.normalizedRecords || []).map((row) => `${row.rawObservationId}\u001f${row.transformationVersion}`));
  const actual = new Set((databaseSnapshot.normalizedRecords || []).map((row) => `${row.rawObservationId}\u001f${row.transformationVersion}`));
  const expectedDates = new Map((plan.rawRecords || []).map((row) => [row.rawObservationId, row.snapshotParkDate]));
  const actualDates = new Map((databaseSnapshot.rawRecords || []).map((row) => [row.rawObservationId, row.snapshotParkDate]));
  const rawIds = new Set((databaseSnapshot.rawRecords || []).map((row) => row.rawObservationId));
  const collector = createMismatchCollector();
  const missing = collectLineageKeysByDate(expected, actual, expectedDates);
  const unexpected = collectLineageKeysByDate(actual, expected, actualDates);
  for (const [date, group] of missing) {
    collector.add({
      type: "missing_normalized_lineage",
      date,
      expected: group.samples,
      expected_count: group.count,
      actual: [],
      actual_count: 0,
      sample_limit: parityDiagnosticSampleLimit
    }, group.count);
  }
  for (const [date, group] of unexpected) {
    collector.add({
      type: "unexpected_normalized_lineage",
      date,
      expected: [],
      expected_count: 0,
      actual: group.samples,
      actual_count: group.count,
      sample_limit: parityDiagnosticSampleLimit
    }, group.count);
  }
  let orphanCount = 0;
  const orphanSamples = [];
  for (const row of databaseSnapshot.normalizedRecords || []) {
    if (rawIds.has(row.rawObservationId)) continue;
    orphanCount += 1;
    pushSortedSample(orphanSamples, row.rawObservationId, parityDiagnosticSampleLimit);
  }
  if (orphanCount) {
    collector.add({
      type: "orphan_normalized_lineage",
      date: null,
      expected: [],
      expected_count: 0,
      actual: orphanSamples,
      actual_count: orphanCount,
      sample_limit: parityDiagnosticSampleLimit
    }, orphanCount);
  }
  return collector.finish();
}

function collectLineageKeysByDate(source, comparedWith, dateByRawId) {
  const grouped = new Map();
  for (const key of source) {
    if (comparedWith.has(key)) continue;
    const rawId = key.slice(0, key.indexOf("\u001f"));
    const date = dateByRawId.get(rawId) || null;
    if (!grouped.has(date)) grouped.set(date, { count: 0, samples: [] });
    const group = grouped.get(date);
    group.count += 1;
    pushSortedSample(group.samples, key, parityDiagnosticSampleLimit);
  }
  return grouped;
}

function pushSortedSample(samples, value, limit) {
  const valueKey = sampleSortKey(value);
  if (samples.length === limit && valueKey >= sampleSortKey(samples.at(-1))) return;
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sampleSortKey(samples[middle]) < valueKey) low = middle + 1;
    else high = middle;
  }
  samples.splice(low, 0, value);
  if (samples.length > limit) samples.pop();
}

function sampleSortKey(value) {
  const key = typeof value === "object" && value !== null ? value.key : value;
  return String(key);
}

function compareCanonicalIdentity(plan, databaseSnapshot) {
  const expected = new Map((plan.normalizedRecords || []).map((row) => [
    `${row.rawObservationId}\u001f${row.transformationVersion}`,
    row.canonicalAttractionId
  ]));
  const actual = new Map((databaseSnapshot.normalizedRecords || []).map((row) => [
    `${row.rawObservationId}\u001f${row.transformationVersion}`,
    row.canonicalAttractionId
  ]));
  const rawById = new Map((plan.rawRecords || []).map((row) => [row.rawObservationId, row]));
  const grouped = new Map();
  for (const [key, expectedId] of expected) {
    const actualId = actual.get(key);
    if (actualId !== expectedId) {
      const date = rawById.get(key.split("\u001f")[0])?.snapshotParkDate;
      const groupKey = date ?? null;
      if (!grouped.has(groupKey)) grouped.set(groupKey, { count: 0, samples: [] });
      const group = grouped.get(groupKey);
      group.count += 1;
      pushSortedSample(group.samples, { key, expected: expectedId, actual: actualId ?? null }, parityDiagnosticSampleLimit);
    }
  }
  const collector = createMismatchCollector();
  for (const [date, group] of grouped) {
    collector.add({
      type: "canonical_attraction_id",
      date,
      mismatch_count: group.count,
      samples: group.samples,
      sample_limit: parityDiagnosticSampleLimit
    }, group.count);
  }
  return collector.finish();
}

function compareOperatingCoverage(expectedByDate, actualByDate, windows) {
  if (!Array.isArray(windows) || windows.length === 0) {
    return failedCheck([{ type: "operating_window_unavailable", expected: "at_least_one_window", actual: 0 }]);
  }
  const normalizedWindows = windows
    .map(normalizeWindow)
    .filter((window) => window && expectedByDate.has(window.date));
  const collector = createMismatchCollector();
  const availableWindowKeys = new Set(normalizedWindows.map((window) => `${window.date}\u001f${window.parkId}`));
  for (const [date, summary] of expectedByDate) {
    for (const parkId of new Set((summary.rawRows || []).map((row) => String(row.parkId)))) {
      if (!availableWindowKeys.has(`${date}\u001f${parkId}`)) {
        collector.add({ date, type: "operating_window_unavailable", expected: `${date}/${parkId}`, actual: null });
      }
    }
  }
  for (const window of normalizedWindows) {
    const key = window.date;
    const expected = expectedByDate.get(key);
    const actual = actualByDate.get(key);
    if (!expected || !actual) {
      collector.add({ date: key, type: "operating_window_date_missing", expected: Boolean(expected), actual: Boolean(actual) });
      continue;
    }
    const expectedRows = expected.rawRows || [];
    const actualRows = actual.rawRows || [];
    const expectedCoverage = coverageForWindow(expectedRows, window);
    const actualCoverage = coverageForWindow(actualRows, window);
    for (const field of ["observed_snapshot_count", "in_window_observation_count", "largest_gap_minutes"]) {
      if (!sameValue(expectedCoverage[field], actualCoverage[field])) {
        const mismatch = {
          date: key,
          type: `operating_window_${field}`,
          expected: expectedCoverage[field],
          actual: actualCoverage[field]
        };
        collector.add(mismatch, differenceMagnitude(mismatch.expected, mismatch.actual));
      }
    }
  }
  return collector.finish();
}

function normalizeWindow(window) {
  const open = new Date(window.openingTime ?? window.opening_time);
  const close = new Date(window.closingTime ?? window.closing_time);
  if (!window.date || Number.isNaN(open.getTime()) || Number.isNaN(close.getTime()) || close <= open) return null;
  return { date: String(window.date), parkId: String(window.parkId ?? window.park_id ?? ""), open, close };
}

function coverageForWindow(rows, window) {
  const snapshots = [...new Set(rows
    .filter((row) => !window.parkId || String(row.parkId) === window.parkId)
    .map((row) => new Date(row.snapshotUtc).getTime())
    .filter((value) => Number.isFinite(value)))]
    .sort((a, b) => a - b);
  const inWindow = snapshots.filter((value) => value >= window.open.getTime() && value <= window.close.getTime());
  const inWindowObservationCount = rows.filter((row) => {
    if (window.parkId && String(row.parkId) !== window.parkId) return false;
    const value = new Date(row.snapshotUtc).getTime();
    return Number.isFinite(value) && value >= window.open.getTime() && value <= window.close.getTime();
  }).length;
  const boundaries = [window.open.getTime(), ...inWindow, window.close.getTime()];
  const gaps = [];
  for (let index = 1; index < boundaries.length; index += 1) gaps.push((boundaries[index] - boundaries[index - 1]) / 60_000);
  return {
    observed_snapshot_count: inWindow.length,
    in_window_observation_count: inWindowObservationCount,
    largest_gap_minutes: gaps.length ? Math.max(...gaps) : (window.close.getTime() - window.open.getTime()) / 60_000
  };
}

function sameValue(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
  }
  return left === right;
}

function toBoolean(value) {
  if (typeof value === "boolean") return value;
  return /^true$/i.test(String(value));
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const date = process.argv.find((argument) => argument.startsWith("--date="))?.slice("--date=".length) || undefined;
  const plan = await buildBackfillPlan(root, { date });
  const windows = await loadOperatingWindows(root, { date });
  let databaseSnapshot = null;
  let databaseError = null;
  if (!process.env.DATABASE_URL) {
    databaseError = "DATABASE_URL is required for database parity";
  } else {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const client = await pool.connect();
      try {
        await client.query("BEGIN TRANSACTION READ ONLY");
        try {
          databaseSnapshot = await loadDatabaseSnapshot(client, {
            archiveIds: plan.archives.map((archive) => archive.rawArchiveId),
            transformationVersions: [...new Set(plan.normalizedRecords.map((row) => row.transformationVersion))]
          });
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          databaseError = error.message;
        }
      } finally {
        client.release();
      }
    } catch (error) {
      databaseError = error.message;
    } finally {
      await pool.end();
    }
  }
  const report = buildReplayParityReport({ plan, databaseSnapshot, operatingWindows: windows, databaseError });
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "passed") process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
