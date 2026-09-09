import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  auditWaitTimeHistory,
  normalizeWaitObservation
} from "../../modules/observations/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("audit contract exposes coverage and conservative availability dispositions", async () => {
  const schema = JSON.parse(await readFile(
    path.join(root, "packages/contracts/schemas/v1/wait-time-history-audit.schema.json"),
    "utf8"
  ));
  assert.equal(schema.properties.contract_version.const, "wait-time-history-audit.v1");
  assert.ok(schema.required.includes("daily_coverage"));
  assert.ok(schema.required.includes("attraction_availability"));
  assert.ok(
    schema.properties.attraction_availability.items.properties.availability_disposition.enum
      .includes("sustained_unavailability_review")
  );
});

test("normalization preserves missing open waits as null and closed zero as status evidence", () => {
  const missing = normalizeWaitObservation(rawRow({
    ride_id: "missing",
    ride_name: "Missing Wait",
    is_open: "TRUE",
    wait_time_minutes: ""
  }));
  assert.equal(missing.observedWaitTimeMinutes, null);
  assert.deepEqual(missing.qualityFlags, ["missing_wait"]);
  assert.equal(missing.trainingEligibility, "exclude_missing_wait");

  const closed = normalizeWaitObservation(rawRow({
    ride_id: "closed",
    ride_name: "Closed Ride",
    is_open: "FALSE",
    wait_time_minutes: "0"
  }));
  assert.equal(closed.observedWaitTimeMinutes, null);
  assert.deepEqual(closed.qualityFlags, ["closed"]);
  assert.equal(closed.trainingEligibility, "status_model_only");

  const openZero = normalizeWaitObservation(rawRow({
    ride_id: "open-zero",
    ride_name: "Open Zero",
    is_open: "TRUE",
    wait_time_minutes: "0"
  }));
  assert.equal(openZero.observedWaitTimeMinutes, 0);
  assert.deepEqual(openZero.qualityFlags, ["open_zero"]);
  assert.equal(openZero.trainingEligibility, "standby_wait_model");
});

test("history audit separates temporary downtime from sustained unavailability", () => {
  const rows = [];
  const operatingWindows = [];
  for (let day = 1; day <= 8; day += 1) {
    const date = `2026-07-${String(day).padStart(2, "0")}`;
    const open = `${date}T15:00:00.000Z`;
    const close = `${date}T15:45:00.000Z`;
    operatingWindows.push({ date, parkId: "disneyland", openingTime: open, closingTime: close });
    for (let slot = 0; slot < 4; slot += 1) {
      const snapshot = new Date(Date.parse(open) + slot * 15 * 60_000).toISOString();
      rows.push(rawRow({
        snapshot_utc: snapshot,
        snapshot_park_date: date,
        ride_id: "long-closed",
        ride_name: "Long Closed",
        is_open: "FALSE",
        wait_time_minutes: "0"
      }));
      rows.push(rawRow({
        snapshot_utc: snapshot,
        snapshot_park_date: date,
        ride_id: "temporary",
        ride_name: "Temporary",
        is_open: slot === 1 ? "FALSE" : "TRUE",
        wait_time_minutes: slot === 1 ? "0" : "20"
      }));
    }
  }

  const report = auditWaitTimeHistory(
    { rows, operatingWindows },
    {
      generatedAt: "2026-07-09T00:00:00.000Z",
      minimumHistoryDays: 7
    }
  );
  const longClosed = report.attraction_availability.find((ride) => ride.source_ride_id === "long-closed");
  const temporary = report.attraction_availability.find((ride) => ride.source_ride_id === "temporary");
  assert.equal(longClosed.availability_disposition, "sustained_unavailability_review");
  assert.equal(longClosed.prediction_recommendation, "exclude_sustained_unavailability");
  assert.equal(longClosed.max_consecutive_full_day_unavailable_days, 8);
  assert.equal(temporary.availability_disposition, "temporary_downtime_observed");
  assert.equal(temporary.prediction_recommendation, "eligible_candidate");
  assert.equal(temporary.temporary_downtime_days, 8);
  assert.equal(report.summary.complete_operating_day_count, 8);
  assert.equal(report.forecast_readiness.status, "baseline_only");
});

test("history audit excludes Single Rider from standby prediction candidates", () => {
  const date = "2026-07-01";
  const rows = [
    rawRow({
      ride_id: "single",
      ride_name: "Example Ride Single Rider",
      wait_time_minutes: "15"
    })
  ];
  const report = auditWaitTimeHistory({
    rows,
    operatingWindows: [{
      date,
      parkId: "disneyland",
      openingTime: `${date}T15:00:00.000Z`,
      closingTime: `${date}T15:15:00.000Z`
    }]
  }, { generatedAt: "2026-07-02T00:00:00.000Z" });
  const singleRider = report.attraction_availability[0];
  assert.equal(singleRider.access_mode, "single_rider");
  assert.equal(singleRider.prediction_recommendation, "exclude_non_standby");
});

function rawRow(overrides = {}) {
  return {
    snapshot_utc: "2026-07-01T15:00:00.000Z",
    snapshot_park_date: "2026-07-01",
    snapshot_timezone: "America/Los_Angeles",
    park_id: "disneyland",
    ride_id: "ride",
    ride_name: "Ride",
    is_open: "TRUE",
    wait_time_minutes: "20",
    source_last_updated_utc: "2026-07-01T14:59:00.000Z",
    ...overrides
  };
}
