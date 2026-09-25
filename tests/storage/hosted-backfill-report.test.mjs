import assert from "node:assert/strict";
import test from "node:test";
import { buildHostedBackfillReport } from "../../scripts/report-hosted-backfill.mjs";

const shaA = "a".repeat(64);
const shaB = "b".repeat(64);

function planFixture() {
  return {
    archives: [
      { rawArchiveId: shaA, sha256: shaA, sourceName: "wait_times_2026-07-01.csv", filePath: "data/wait_times/wait_times_2026-07-01.csv", byteSize: 10 },
      { rawArchiveId: shaB, sha256: shaB, sourceName: "wait_times_2026-07-02.csv", filePath: "data/wait_times/wait_times_2026-07-02.csv", byteSize: 20 }
    ],
    rawRecords: [
      { rawArchiveId: shaA, rawObservationId: "raw-a-1" },
      { rawArchiveId: shaA, rawObservationId: "raw-a-2" },
      { rawArchiveId: shaB, rawObservationId: "raw-b-1" }
    ],
    normalizedRecords: [
      { rawObservationId: "raw-a-1" },
      { rawObservationId: "raw-b-1" }
    ]
  };
}

test("hosted backfill report matches archives and keeps unexpected smoke data separate", () => {
  const plan = planFixture();
  const report = buildHostedBackfillReport({
    plan,
    root: "",
    bucket: "validation-bucket",
    targetLabel: "neon-validation-branch-only",
    neon: {
      archives: [
        { raw_archive_id: shaA, sha256: shaA, byte_size: 10, source_name: "wait_times_2026-07-01.csv", object_uri: `s3://validation-bucket/wait-times/${shaA}/wait_times_2026-07-01.csv` },
        { raw_archive_id: "c".repeat(64), sha256: "c".repeat(64), byte_size: 4, source_name: "wait_times_snapshot_smoke.csv", object_uri: "s3://validation-bucket/smoke" }
      ],
      rawCounts: new Map([[shaA, 2], ["c".repeat(64), 1]]),
      normalizedCounts: new Map([[shaA, 1]]),
    },
    r2: {
      objects: [
        { key: `wait-times/${shaA}/wait_times_2026-07-01.csv`, sha256: shaA, source_name: "wait_times_2026-07-01.csv", size: 10, head_content_length: 10, metadata_sha256: shaA, content_sha256: shaA },
        { key: "wait-times/cccc/smoke.csv", sha256: "cccc", source_name: "smoke.csv", size: 4, etag: "etag" }
      ]
    },
    replayParity: { status: "passed", failures: [] },
    runId: "test-run"
  });

  assert.equal(report.status, "blocked");
  assert.equal(report.archives[0].classification, "matched");
  assert.equal(report.archives[1].classification, "git_only");
  assert.equal(report.classification_counts.matched, 1);
  assert.equal(report.classification_counts.git_only, 1);
  assert.equal(report.classification_counts.neon_only, 1);
  assert.equal(report.classification_counts.r2_only, 1);
  assert.ok(report.failures.some((failure) => failure.type === "git_only"));
});

test("hosted backfill report marks hash and row-count mismatches and requires target confirmation", () => {
  const plan = planFixture();
  const report = buildHostedBackfillReport({
    plan,
    root: "",
    bucket: "validation-bucket",
    targetLabel: "production",
    neon: {
      archives: [{ raw_archive_id: shaA, sha256: "d".repeat(64), byte_size: 10, source_name: "wait_times_2026-07-01.csv" }],
      rawCounts: new Map([[shaA, 99]]),
      normalizedCounts: new Map([[shaA, 1]])
    },
    r2: {
      objects: [{ key: `wait-times/${shaA}/wait_times_2026-07-01.csv`, source_name: "wait_times_2026-07-01.csv", size: 10, head_content_length: 10, metadata_sha256: shaA, content_sha256: "e".repeat(64) }]
    },
    replayParity: { status: "passed", failures: [] },
    runId: "mismatch-run"
  });

  assert.equal(report.status, "blocked");
  assert.equal(report.archives[0].classification, "hash_mismatch");
  assert.ok(report.archives[0].issues.includes("neon:sha256_mismatch"));
  assert.ok(report.archives[0].issues.includes("neon:raw_row_count_mismatch"));
  assert.ok(report.archives[0].issues.includes("r2:content_sha256_mismatch"));
  assert.ok(report.failures.some((failure) => failure.type === "target_confirmation_missing"));
});

test("hosted backfill report treats a verified non-Git Neon/R2 archive as out-of-scope hosted evidence", () => {
  const plan = planFixture();
  plan.archives = plan.archives.slice(0, 1);
  plan.rawRecords = plan.rawRecords.slice(0, 2);
  plan.normalizedRecords = plan.normalizedRecords.slice(0, 1);
  const smokeHash = "c".repeat(64);
  const smokeName = "wait_times_snapshot_smoke.csv";
  const smokeKey = `wait-times/${smokeHash}/${smokeName}`;
  const report = buildHostedBackfillReport({
    plan,
    root: "",
    bucket: "validation-bucket",
    targetLabel: "neon-validation-branch-only",
    neon: {
      archives: [
        { raw_archive_id: shaA, sha256: shaA, byte_size: 10, source_name: "wait_times_2026-07-01.csv", object_uri: `s3://validation-bucket/wait-times/${shaA}/wait_times_2026-07-01.csv` },
        { raw_archive_id: smokeHash, sha256: smokeHash, byte_size: 4, source_name: smokeName, object_uri: `s3://validation-bucket/${smokeKey}` }
      ],
      rawCounts: new Map([[shaA, 2], [smokeHash, 88]]),
      normalizedCounts: new Map([[shaA, 1]])
    },
    r2: {
      objects: [
        { key: `wait-times/${shaA}/wait_times_2026-07-01.csv`, sha256: shaA, source_name: "wait_times_2026-07-01.csv", size: 10, head_content_length: 10, metadata_sha256: shaA, content_sha256: shaA },
        { key: smokeKey, sha256: smokeHash, source_name: smokeName, size: 4, head_content_length: 4, metadata_sha256: smokeHash, content_sha256: smokeHash }
      ]
    },
    replayParity: { status: "passed", failures: [] },
    runId: "hosted-only-run"
  });

  assert.equal(report.status, "passed");
  assert.equal(report.classification_counts.hosted_only, 1);
  assert.equal(report.classification_counts.neon_only, 0);
  assert.equal(report.classification_counts.r2_only, 0);
  assert.equal(report.hosted_only[0].source_name, smokeName);
  assert.ok(!report.failures.some((failure) => failure.type === "neon_only" || failure.type === "r2_only"));
});

test("hosted backfill report bounds difference lists but keeps complete counts and all Git archive evidence", () => {
  const plan = planFixture();
  const neonOnlyArchives = Array.from({ length: 25 }, (_, index) => {
    const hash = String(index + 1).padStart(64, "c");
    return {
      raw_archive_id: hash,
      sha256: hash,
      byte_size: index + 1,
      source_name: `unexpected-${index + 1}.csv`
    };
  });
  const replayFailures = Array.from({ length: 30 }, (_, index) => ({ type: "missing_normalized_lineage", key: `raw-${index}` }));
  const replayMismatches = Array.from({ length: 64 }, (_, index) => ({ date: `2026-08-${String(index + 1).padStart(2, "0")}` }));
  const report = buildHostedBackfillReport({
    plan,
    root: "",
    bucket: "validation-bucket",
    targetLabel: "neon-validation-branch-only",
    neon: {
      archives: neonOnlyArchives,
      rawCounts: new Map(),
      normalizedCounts: new Map()
    },
    r2: { objects: [] },
    replayParity: {
      status: "blocked",
      failure_count: 64,
      failures: replayFailures,
      checks: {
        lineage: {
          mismatch_count: 64,
          difference_count: 740,
          mismatches: replayMismatches.slice(0, 20)
        }
      }
    },
    runId: "bounded-samples-run"
  });

  assert.equal(report.status, "blocked");
  assert.equal(report.archives.length, 2);
  assert.deepEqual(report.archives.map((archive) => archive.sha256), [shaA, shaB]);
  assert.deepEqual(report.archives.map((archive) => [archive.row_count, archive.normalized_row_count]), [[2, 1], [1, 1]]);
  assert.equal(report.classification_counts.neon_only, 25);
  assert.equal(report.neon_only.length, 20);
  assert.deepEqual(report.diagnostic_samples.neon_only, { total_count: 25, included_count: 20, omitted_count: 5 });
  assert.equal(report.failures.find((failure) => failure.type === "neon_only").count, 25);
  assert.equal(report.failures.find((failure) => failure.type === "neon_only").omitted_count, 5);
  assert.equal(report.failures.find((failure) => failure.type === "replay_parity_blocked").failure_count, 64);
  assert.equal(report.failures.find((failure) => failure.type === "replay_parity_blocked").detail.length, 20);
  assert.equal(report.diagnostic_samples.replay_parity.checks.lineage.difference_count, 740);
});
