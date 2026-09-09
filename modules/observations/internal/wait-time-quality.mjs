export const auditPolicyVersion = "wait-time-quality.v1";

const parkTimezone = "America/Los_Angeles";

export function normalizeWaitObservation(raw, options = {}) {
  const staleAfterMinutes = options.staleAfterMinutes ?? 60;
  const isOpen = parseBoolean(raw.is_open ?? raw.isOpen);
  const waitTimeMinutes = parseNullableNonNegativeNumber(raw.wait_time_minutes ?? raw.waitTimeMinutes);
  const snapshotUtc = parseInstant(raw.snapshot_utc ?? raw.snapshotUtc, "snapshot_utc");
  const sourceUpdatedUtc = parseInstant(
    raw.source_last_updated_utc ?? raw.sourceLastUpdatedUtc,
    "source_last_updated_utc"
  );
  const sourceAgeMinutes = Math.max(0, (snapshotUtc.getTime() - sourceUpdatedUtc.getTime()) / 60_000);
  const accessMode = inferAccessMode(raw.ride_name ?? raw.rideName, raw.access_mode ?? raw.accessMode);
  const qualityFlags = [];

  if (!isOpen) qualityFlags.push("closed");
  if (isOpen && waitTimeMinutes === null) qualityFlags.push("missing_wait");
  if (isOpen && waitTimeMinutes === 0) qualityFlags.push("open_zero");
  if (sourceAgeMinutes > staleAfterMinutes) qualityFlags.push("stale_source");

  let trainingEligibility = "standby_wait_model";
  if (qualityFlags.includes("stale_source")) trainingEligibility = "exclude_stale_source";
  else if (accessMode !== "standby") trainingEligibility = "exclude_non_standby_access_mode";
  else if (!isOpen) trainingEligibility = "status_model_only";
  else if (waitTimeMinutes === null) trainingEligibility = "exclude_missing_wait";

  return {
    isOpen,
    accessMode,
    observedWaitTimeMinutes: isOpen ? waitTimeMinutes : null,
    sourceAgeMinutes: round(sourceAgeMinutes, 3),
    qualityFlags,
    trainingEligibility
  };
}

export function auditWaitTimeHistory(input, options = {}) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const sampleIntervalMinutes = options.sampleIntervalMinutes ?? 15;
  const maximumCompleteGapMinutes = options.maximumCompleteGapMinutes ?? 30.5;
  const completeCoverageRatio = options.completeCoverageRatio ?? 0.95;
  const fullDayUnavailableRatio = options.fullDayUnavailableRatio ?? 0.9;
  const sustainedUnavailableDays = options.sustainedUnavailableDays ?? 7;
  const minimumOpenDays = options.minimumOpenDays ?? 3;
  const minimumHistoryDays = options.minimumHistoryDays ?? 42;
  const rows = [];
  const invalidRows = [];

  for (const [index, raw] of (input.rows || []).entries()) {
    try {
      const normalized = normalizeWaitObservation(raw, options);
      const snapshotUtc = parseInstant(raw.snapshot_utc ?? raw.snapshotUtc, "snapshot_utc");
      const date = String(raw.snapshot_park_date ?? raw.snapshotParkDate ?? "");
      const timezone = String(raw.snapshot_timezone ?? raw.snapshotTimezone ?? "");
      const parkId = String(raw.park_id ?? raw.parkId ?? "");
      const rideId = String(raw.ride_id ?? raw.rideId ?? "");
      const rideName = String(raw.ride_name ?? raw.rideName ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("invalid snapshot_park_date");
      if (timezone !== parkTimezone) throw new Error("unsupported snapshot_timezone");
      if (!parkId || !rideId || !rideName) throw new Error("missing park or ride identity");
      rows.push({ raw, normalized, snapshotUtc, date, parkId, rideId, rideName });
    } catch (error) {
      invalidRows.push({ rowNumber: index + 1, reason: error.message });
    }
  }

  const windows = (input.operatingWindows || [])
    .map(normalizeWindow)
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date) || a.parkId.localeCompare(b.parkId));
  const dailyCoverage = windows.map((window) =>
    buildDailyCoverage(window, rows, {
      sampleIntervalMinutes,
      maximumCompleteGapMinutes,
      completeCoverageRatio
    })
  );
  const completeWindowKeys = new Set(
    dailyCoverage.filter((day) => day.is_complete).map((day) => `${day.date}\u001f${day.park_id}`)
  );
  const windowsByKey = new Map(windows.map((window) => [`${window.date}\u001f${window.parkId}`, window]));
  const inParkRows = rows.filter((row) => isInsideOperatingWindow(row, windowsByKey));
  const availability = buildAttractionAvailability(inParkRows, completeWindowKeys, {
    fullDayUnavailableRatio,
    sustainedUnavailableDays,
    minimumOpenDays
  });
  const dates = [...new Set(rows.map((row) => row.date))].sort();
  const parkIds = [...new Set(rows.map((row) => row.parkId))].sort();
  const completeOperatingDayCount = dailyCoverage.filter((day) => day.is_complete).length;
  const readinessReasons = [];
  if (dates.length < minimumHistoryDays) readinessReasons.push("history_days_below_policy_minimum");
  if (completeOperatingDayCount < dailyCoverage.length) readinessReasons.push("incomplete_operating_day_coverage");
  if (invalidRows.length) readinessReasons.push("invalid_observations_present");
  if (availability.some((ride) => ride.availability_disposition === "sustained_unavailability_review")) {
    readinessReasons.push("sustained_unavailability_requires_catalog_review");
  }

  let readinessStatus = "ready_for_modeling";
  if (readinessReasons.includes("history_days_below_policy_minimum")) readinessStatus = "not_ready";
  else if (readinessReasons.length) readinessStatus = "baseline_only";

  return {
    contract_version: "wait-time-history-audit.v1",
    policy_version: auditPolicyVersion,
    generated_at: generatedAt,
    scope: {
      start_date: dates[0] || null,
      end_date: dates.at(-1) || null,
      timezone: parkTimezone,
      park_ids: parkIds
    },
    summary: {
      raw_observation_count: (input.rows || []).length,
      valid_observation_count: rows.length,
      invalid_observation_count: invalidRows.length,
      snapshot_count: new Set(rows.map((row) => row.snapshotUtc.toISOString())).size,
      open_observation_count: rows.filter((row) => row.normalized.isOpen).length,
      closed_observation_count: rows.filter((row) => !row.normalized.isOpen).length,
      missing_wait_while_open_count: rows.filter((row) => row.normalized.qualityFlags.includes("missing_wait")).length,
      explicit_open_zero_count: rows.filter((row) => row.normalized.qualityFlags.includes("open_zero")).length,
      stale_observation_count: rows.filter((row) => row.normalized.qualityFlags.includes("stale_source")).length,
      operating_day_count: dailyCoverage.length,
      complete_operating_day_count: completeOperatingDayCount,
      attraction_count: availability.length,
      eligible_candidate_count: availability.filter((ride) => ride.prediction_recommendation === "eligible_candidate").length,
      sustained_unavailability_review_count: availability.filter(
        (ride) => ride.availability_disposition === "sustained_unavailability_review"
      ).length
    },
    forecast_readiness: {
      status: readinessStatus,
      reasons: readinessReasons
    },
    daily_coverage: dailyCoverage,
    attraction_availability: availability
  };
}

function buildDailyCoverage(window, rows, policy) {
  const snapshotTimes = [...new Set(
    rows
      .filter(
        (row) =>
          row.parkId === window.parkId &&
          row.snapshotUtc >= window.open &&
          row.snapshotUtc <= window.close
      )
      .map((row) => row.snapshotUtc.getTime())
  )].sort((a, b) => a - b);
  const durationMinutes = (window.close.getTime() - window.open.getTime()) / 60_000;
  const expected = Math.max(1, Math.ceil(durationMinutes / policy.sampleIntervalMinutes));
  const boundaryAndSnapshots = [window.open.getTime(), ...snapshotTimes, window.close.getTime()];
  const gaps = [];
  for (let index = 1; index < boundaryAndSnapshots.length; index += 1) {
    gaps.push((boundaryAndSnapshots[index] - boundaryAndSnapshots[index - 1]) / 60_000);
  }
  const largestGapMinutes = gaps.length ? Math.max(...gaps) : durationMinutes;
  const coverageRatio = expected ? Math.min(1, snapshotTimes.length / expected) : 0;
  return {
    date: window.date,
    park_id: window.parkId,
    scheduled_open_utc: window.open.toISOString(),
    scheduled_close_utc: window.close.toISOString(),
    expected_snapshot_count: expected,
    observed_snapshot_count: snapshotTimes.length,
    coverage_ratio: round(coverageRatio, 4),
    large_gap_count: gaps.filter((gap) => gap > policy.maximumCompleteGapMinutes).length,
    largest_gap_minutes: round(largestGapMinutes, 3),
    is_complete:
      coverageRatio >= policy.completeCoverageRatio &&
      largestGapMinutes <= policy.maximumCompleteGapMinutes
  };
}

function buildAttractionAvailability(rows, completeWindowKeys, policy) {
  const byRide = groupBy(rows, (row) => `${row.parkId}\u001f${row.rideId}`);
  const availability = [];

  for (const rideRows of byRide.values()) {
    rideRows.sort((a, b) => a.snapshotUtc - b.snapshotUtc);
    const first = rideRows[0];
    const byDate = groupBy(rideRows, (row) => row.date);
    const daily = [...byDate.entries()]
      .map(([date, dayRows]) => {
        const openRows = dayRows.filter((row) => row.normalized.isOpen).length;
        const closedRows = dayRows.length - openRows;
        const transitions = countTransitions(dayRows.map((row) => row.normalized.isOpen));
        return {
          date,
          isCompleteDay: completeWindowKeys.has(`${date}\u001f${first.parkId}`),
          openRows,
          closedRows,
          temporaryDowntime: openRows > 0 && closedRows > 0 && transitions >= 2,
          fullDayUnavailable: false
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));

    for (const day of daily) {
      const total = day.openRows + day.closedRows;
      day.fullDayUnavailable =
        day.isCompleteDay &&
        total > 0 &&
        day.closedRows / total >= policy.fullDayUnavailableRatio;
    }

    const unavailableDates = daily.filter((day) => day.fullDayUnavailable).map((day) => day.date);
    const maximumUnavailableStreak = maxConsecutiveDates(unavailableDates);
    const openDays = daily.filter((day) => day.openRows > 0).length;
    const temporaryDowntimeDays = daily.filter((day) => day.temporaryDowntime).length;
    const accessMode = first.normalized.accessMode;
    const reasons = [];
    let availabilityDisposition = temporaryDowntimeDays
      ? "temporary_downtime_observed"
      : "operational_observed";
    let predictionRecommendation = "eligible_candidate";

    if (accessMode !== "standby") {
      availabilityDisposition = "non_standby";
      predictionRecommendation = "exclude_non_standby";
      reasons.push("access_mode_is_not_standby");
    } else if (maximumUnavailableStreak >= policy.sustainedUnavailableDays) {
      availabilityDisposition = "sustained_unavailability_review";
      predictionRecommendation = "exclude_sustained_unavailability";
      reasons.push("consecutive_full_day_unavailability_threshold_reached");
      reasons.push("catalog_review_required_before_refurbishment_or_retirement_label");
    } else if (openDays < policy.minimumOpenDays) {
      availabilityDisposition = "insufficient_evidence";
      predictionRecommendation = "exclude_insufficient_open_evidence";
      reasons.push("open_days_below_policy_minimum");
    }

    availability.push({
      park_id: first.parkId,
      source_ride_id: first.rideId,
      ride_name: mostFrequent(rideRows.map((row) => row.rideName)),
      access_mode: accessMode,
      observed_days: daily.length,
      open_days: openDays,
      temporary_downtime_days: temporaryDowntimeDays,
      full_day_unavailable_days: unavailableDates.length,
      max_consecutive_full_day_unavailable_days: maximumUnavailableStreak,
      open_observation_count: rideRows.filter((row) => row.normalized.isOpen).length,
      closed_observation_count: rideRows.filter((row) => !row.normalized.isOpen).length,
      missing_wait_while_open_count: rideRows.filter((row) => row.normalized.qualityFlags.includes("missing_wait")).length,
      explicit_open_zero_count: rideRows.filter((row) => row.normalized.qualityFlags.includes("open_zero")).length,
      availability_disposition: availabilityDisposition,
      prediction_recommendation: predictionRecommendation,
      reasons
    });
  }

  return availability.sort(
    (a, b) =>
      a.park_id.localeCompare(b.park_id) ||
      a.ride_name.localeCompare(b.ride_name) ||
      a.source_ride_id.localeCompare(b.source_ride_id)
  );
}

function normalizeWindow(window) {
  try {
    const open = parseInstant(window.opening_time ?? window.openingTime, "opening_time");
    const close = parseInstant(window.closing_time ?? window.closingTime, "closing_time");
    const date = String(window.date || "");
    const parkId = String(window.park_id ?? window.parkId ?? "");
    if (!parkId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || close <= open) return null;
    return { date, parkId, open, close };
  } catch {
    return null;
  }
}

function isInsideOperatingWindow(row, windowsByKey) {
  const window = windowsByKey.get(`${row.date}\u001f${row.parkId}`);
  return window ? row.snapshotUtc >= window.open && row.snapshotUtc <= window.close : false;
}

function inferAccessMode(rideName, explicitMode) {
  if (["standby", "single_rider", "virtual_queue", "other"].includes(explicitMode)) return explicitMode;
  const name = String(rideName || "");
  if (/\bsingle\s+rider\b/i.test(name)) return "single_rider";
  if (/\bvirtual\s+queue\b/i.test(name)) return "virtual_queue";
  return "standby";
}

function parseBoolean(value) {
  if (value === true || /^true$/i.test(String(value))) return true;
  if (value === false || /^false$/i.test(String(value))) return false;
  throw new Error(`invalid boolean: ${value}`);
}

function parseNullableNonNegativeNumber(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`invalid non-negative wait: ${value}`);
  return number;
}

function parseInstant(value, field) {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) throw new Error(`invalid ${field}: ${value}`);
  return instant;
}

function groupBy(values, key) {
  const groups = new Map();
  for (const value of values) {
    const groupKey = key(value);
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(value);
  }
  return groups;
}

function countTransitions(values) {
  let transitions = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] !== values[index - 1]) transitions += 1;
  }
  return transitions;
}

function maxConsecutiveDates(dates) {
  const sorted = [...new Set(dates)].sort();
  let maximum = 0;
  let current = 0;
  let previous = null;
  for (const date of sorted) {
    const timestamp = Date.parse(`${date}T00:00:00Z`);
    if (previous !== null && timestamp - previous === 86_400_000) current += 1;
    else current = 1;
    maximum = Math.max(maximum, current);
    previous = timestamp;
  }
  return maximum;
}

function mostFrequent(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || "";
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
