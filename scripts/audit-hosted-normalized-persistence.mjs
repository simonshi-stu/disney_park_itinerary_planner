import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCanonicalAttraction } from "../modules/catalog/index.mjs";
import { sourceHealthVersion } from "../modules/ingestion/source-health.mjs";
import { normalizeArchivedWaitObservation } from "../modules/observations/index.mjs";
import { calculateRawObservationId } from "../infra/archive-line-reference-postgres.mjs";
import {
  buildBackfillPlan,
  parseCsv,
  rawSchemaVersion
} from "../infra/backfill/wait-time-records.mjs";
import {
  maximumCapacityMeasurementAgeMs,
  r2ReplayTransformationVersion
} from "../infra/backfill/r2-normalized-records.mjs";
import { calculateNormalizedObservationId } from "../infra/normalized-observations-postgres.mjs";
import {
  assertCurrentValidationAuthorization,
  calculateDatabaseFingerprint,
  normalizedOnlyTransformationVersion
} from "../infra/normalized-only-hosted-write.mjs";

export const hostedNormalizedAuditContractVersion = "hosted-normalized-audit-report.v1";
export const hostedNormalizedAuditAdapterVersion = "hosted-normalized-audit.v2";
export const defaultDiagnosticSampleLimit = 20;
export const defaultAuditBatchSize = 200;
/** Safe finite cap for every bounded audit IN-list query. */
export const maximumAuditBatchSize = 500;

/** Resolve a positive batch size and cap it so no query list can grow unbounded. */
export function resolveAuditBatchSize(value) {
  return Math.min(positiveInteger(value, defaultAuditBatchSize), maximumAuditBatchSize);
}

const SHA256 = /^[a-f0-9]{64}$/;
const R2_PREFIX = "wait-times/";
const PRODUCTION_LABEL_PATTERN = /\b(prod|production)\b/i;
const ARCHIVE_REFERENCE_VERSION = "raw-archive-line-reference.v1";
const NORMALIZED_V2_VERSION = "normalized-wait-observation.v2";
const HISTORY_TRANSFORMATION_VERSION = r2ReplayTransformationVersion;
const LIVE_TRANSFORMATION_VERSION = normalizedOnlyTransformationVersion;
const EXPECTED_TRANSFORMATION_VERSIONS = [LIVE_TRANSFORMATION_VERSION, HISTORY_TRANSFORMATION_VERSION];
const REFERENCE_FIELDS = [
  "contract_version",
  "raw_observation_id",
  "raw_archive_id",
  "r2_uri",
  "archive_sha256",
  "archive_byte_size",
  "source_line_number",
  "source_name",
  "archive_schema_version"
];
const NORMALIZED_FIELDS = [
  "normalized_observation_id",
  "contract_version",
  "raw_observation_id",
  "operator_id",
  "resort_id",
  "park_id",
  "park_timezone",
  "observed_at_utc",
  "canonical_attraction_id",
  "canonical_attraction_name",
  "canonical_category",
  "canonical_match_source",
  "access_mode",
  "is_open",
  "observed_wait_time_minutes",
  "quality_flags",
  "training_eligibility",
  "transformation_version",
  "generated_at"
];
const NORMALIZED_SEMANTIC_FIELDS = NORMALIZED_FIELDS.filter((field) => field !== "generated_at");
const REQUIRED_RELATIONS = [
  ["raw_archives", "ingestion.raw_archives"],
  ["raw_wait_observations", "ingestion.raw_wait_observations"],
  ["archive_line_references", "ingestion.raw_archive_line_references"],
  ["normalized_v2", "observations.normalized_wait_observations_v2"],
  ["catalog_entries", "catalog.catalog_entry_snapshots"],
  ["source_health", "ingestion.source_health"]
];

/**
 * Connection-free CLI check report. It never reads environment variables, opens a
 * client, or treats the expired prior validation branch as usable evidence.
 */
export function buildOfflineAuditReport({ checkedAt = new Date().toISOString(), runId = randomUUID() } = {}) {
  const report = createReportBase({
    mode: "offline-check",
    checkedAt: isUtcDateTime(checkedAt) ? checkedAt : new Date().toISOString(),
    runId: isNonEmptyString(runId) ? runId : randomUUID(),
    catalogVersion: null,
    transformationVersions: []
  });
  report.status = "blocked";
  report.blockers = [
    "live_read_only_audit_not_authorized",
    "current_validation_target_not_supplied",
    "read_only_validation_authorization_not_supplied",
    "reviewed_catalog_entry_v1_snapshot_not_supplied",
    "reviewed_structured_access_mode_mapping_not_supplied",
    "historical_git_archive_inventory_not_supplied",
    "live_git_archive_evidence_not_supplied",
    "git_run_evidence_not_supplied",
    "legacy_raw_baseline_not_supplied",
    "capacity_measurement_not_supplied",
    "prior_validation_branch_expired_2026-09-30"
  ];
  report.next_steps = blockedNextSteps();
  return report;
}

/**
 * Read-only audit runner. Phase 0 gates (input safety, target, authorization,
 * reviewed inputs, merged history+live inventory, capacity) run before any
 * reader is requested; live readers are only created by the injected factory
 * after every gate passes.
 */
export async function runHostedNormalizedAudit(options = {}) {
  const blockers = [];
  const checkedAt = resolveCheckedAt(options.checkedAt, blockers);
  const runId = resolveRunId(options.runId, blockers);
  // The runner is always a live read-only audit; the connection-free blocked
  // report is only produced by buildOfflineAuditReport.
  const mode = "live-read-only";
  const sampleLimit = positiveInteger(options.diagnosticSampleLimit, defaultDiagnosticSampleLimit);
  const batchSize = resolveAuditBatchSize(options.batchSize);
  const failures = createFailureCollector(sampleLimit);
  const auditedVersions = new Set();

  if (isNonEmptyString(options.liveInputsError)) {
    blockers.push(`live_audit_inputs_unreadable:${safeErrorText(options.liveInputsError)}`);
  }

  const targetName = typeof options.targetName === "string" ? options.targetName.trim() : "";
  const authorization = options.authorization;
  let targetFingerprint = null;

  if (!targetName) blockers.push("validation_target_name_required");
  else if (PRODUCTION_LABEL_PATTERN.test(targetName)) blockers.push("validation_target_name_must_not_be_production");

  if (typeof options.databaseUrl === "string" && options.databaseUrl.trim() !== "") {
    try {
      targetFingerprint = calculateDatabaseFingerprint(options.databaseUrl);
    } catch (error) {
      blockers.push(`target_fingerprint_rejected:${safeErrorText(error)}`);
    }
  }
  if (options.targetFingerprint !== undefined && options.targetFingerprint !== null) {
    if (!SHA256.test(options.targetFingerprint)) {
      blockers.push("target_fingerprint_invalid");
    } else if (targetFingerprint && targetFingerprint !== options.targetFingerprint) {
      blockers.push("target_fingerprint_mismatch");
    } else {
      targetFingerprint = targetFingerprint || options.targetFingerprint;
    }
  }
  if (!targetFingerprint) blockers.push("target_fingerprint_required");

  if (!authorization || authorization.kind !== "read-only-validation") {
    blockers.push("read_only_validation_authorization_required");
  } else if (targetFingerprint) {
    try {
      assertCurrentValidationAuthorization({
        authorization: { ...authorization, kind: "validation-only" },
        expectedTargetFingerprint: targetFingerprint,
        targetFingerprint,
        now: checkedAt
      });
    } catch (error) {
      blockers.push(`authorization_rejected:${safeErrorText(error)}`);
    }
  }

  blockers.push(...validateCatalogSnapshot(options.catalogSnapshot));
  const accessMappings = validateAccessModeMapping(options.accessModeMapping, options.catalogSnapshot);
  blockers.push(...accessMappings.blockers);

  // Externally supplied 04d5 live per-snapshot evidence is merged with the locally
  // derived historical daily descriptors. Run-to-archive linkage is preserved and
  // duplicate/conflicting descriptors are rejected instead of guessed.
  const inventory = normalizeGitInventory(options.git);
  blockers.push(...inventory.blockers);

  if (!isValidBaseline(options.baseline)) blockers.push("legacy_raw_baseline_required");

  const capacityCheck = validateCapacityEvidence(options.capacity, { checkedAt, targetFingerprint });
  if (!capacityCheck.ok) blockers.push(capacityCheck.code);

  const hasReaders = Boolean(options.readers) || typeof options.readersFactory === "function";
  if (!hasReaders) blockers.push("read_only_readers_required");

  const report = createReportBase({
    mode,
    checkedAt,
    runId,
    catalogVersion: options.catalogSnapshot?.catalog_version ?? null,
    transformationVersions: inventory.versions
  });
  report.capacity = capacityCheck.report;
  report.target = buildTargetEvidence({ targetName, targetFingerprint, authorization });
  report.counts.git_archives = inventory.archives.length;
  report.counts.git_history_archives = inventory.historyCount;
  report.counts.git_live_archives = inventory.liveCount;
  report.counts.git_runs = inventory.runs.length;
  report.counts.raw_rows_expected = inventory.rawRowsExpected;
  report.counts.normalized_expected = inventory.normalizedExpected;
  report.source_health.expected_runs = inventory.runs.length;
  report.source_health.duplicate_runs = inventory.duplicateRuns;
  report.source_health.retried_runs = inventory.retriedRuns;

  if (blockers.length > 0) {
    report.status = "blocked";
    report.blockers = [...new Set(blockers.map(redactSecrets))];
    report.next_steps = blockedNextSteps();
    return report;
  }

  let connectionsOpened = false;
  let readers = options.readers || null;
  let countsBefore = null;
  let aborted = false;
  try {
    if (!readers) readers = await options.readersFactory();
    if (!readers?.database || typeof readers.database.withReadOnlyTransaction !== "function" ||
        !readers.r2 || typeof readers.r2.listObjects !== "function") {
      failures.add("read_only_readers_invalid");
      throw new Error("read-only readers are invalid");
    }
    connectionsOpened = true;

    // Presence is checked before any count/row query so a missing relation is
    // reportable as schema_relation_missing instead of a generic execution failure.
    const context = await readers.database.withReadOnlyTransaction(async ({ query }) => {
      const schema = await loadSchemaPresence(query);
      const missing = missingRequiredRelations(schema);
      if (missing.length > 0) {
        return { schema, missing, counts: null, sourceHealth: null };
      }
      return {
        schema,
        missing,
        counts: await loadCounts(query),
        sourceHealth: await loadSourceHealth(query, inventory.runs.map((run) => ({
          sourceName: run.source_name,
          runId: String(run.run_id)
        })), batchSize)
      };
    });
    if (context.missing.length > 0) {
      for (const relation of context.missing) failures.add("schema_relation_missing", { relation });
      aborted = true;
    } else {
      countsBefore = context.counts;
      applyCounts(report.counts, context.counts);
      checkSourceHealth(report, inventory.runs, context.sourceHealth, failures);

      const r2Inventory = await loadR2Inventory(readers.r2, inventory.archives);
      applyInventory(report, inventory.archives, r2Inventory, failures, sampleLimit);

      for (const archive of inventory.archives) {
        const abortedByArchive = await auditArchive({
          archive,
          inventoryEntry: r2Inventory.byKey.get(expectedObjectKey(archive)),
          readers,
          checkedAt,
          batchSize,
          report,
          failures,
          catalogSnapshot: options.catalogSnapshot,
          accessMappings,
          auditedVersions
        });
        if (abortedByArchive) {
          aborted = true;
          break;
        }
      }
    }

    if (!aborted) {
      const countsAfter = await readers.database.withReadOnlyTransaction(({ query }) => loadCounts(query));
      applyCounts(report.counts, countsAfter);
      checkRawBaseline(report, options.baseline, countsBefore, countsAfter, failures);
    } else {
      report.raw_baseline.expected = expectedBaseline(options.baseline);
      report.raw_baseline.supplied = true;
    }
  } catch (error) {
    failures.add("audit_execution_failed", { code: safeErrorText(error) });
  } finally {
    try {
      await readers?.r2?.close?.();
    } catch {
      // Closing failures must not hide the audit result.
    }
    try {
      await readers?.database?.close?.();
    } catch {
      // Closing failures must not hide the audit result.
    }
    report.connections_opened = connectionsOpened;
  }

  report.versions.audited_transformation_versions = [...auditedVersions].sort();
  report.failures = failures.toArray();
  report.status = report.failures.length > 0 ? "failed" : "passed";
  report.complete = report.status === "passed" && report.inventory.status === "complete";
  report.next_steps = report.status === "passed" ? passedNextSteps() : failedNextSteps();
  return report;
}

async function auditArchive({
  archive,
  inventoryEntry,
  readers,
  checkedAt,
  batchSize,
  report,
  failures,
  catalogSnapshot,
  accessMappings,
  auditedVersions
}) {
  const expectedKey = expectedObjectKey(archive);
  if (!inventoryEntry) {
    failures.add("r2_object_missing", { key: expectedKey });
    return false;
  }
  if (inventoryEntry.size !== archive.byte_size) {
    // Listed size is an explicit early mismatch; head/body remain authoritative.
    failures.add("r2_list_size_mismatch", {
      key: expectedKey,
      expected: archive.byte_size,
      listed: inventoryEntry.size
    });
  }

  let head;
  let bytes;
  try {
    head = await readers.r2.headObject({ bucket: inventoryEntry.bucket, key: expectedKey });
  } catch (error) {
    failures.add("r2_read_failed", { key: expectedKey, phase: "head", code: safeErrorText(error) });
    return false;
  }
  try {
    bytes = await readers.r2.getObject({ bucket: inventoryEntry.bucket, key: expectedKey });
  } catch (error) {
    failures.add("r2_read_failed", { key: expectedKey, phase: "get", code: safeErrorText(error) });
    return false;
  }

  const body = toBytes(bytes);
  if (!body) {
    failures.add("r2_read_failed", { key: expectedKey, phase: "get", code: "body_not_readable" });
    return false;
  }
  const contentSha256 = sha256(body);
  let verified = true;
  if (contentSha256 !== archive.sha256) {
    failures.add("r2_content_sha_mismatch", { key: expectedKey, expected: archive.sha256, actual: contentSha256 });
    verified = false;
  }
  const metadata = head?.metadata || {};
  if (String(metadata.sha256 || "") !== archive.sha256) {
    failures.add("r2_metadata_sha_mismatch", { key: expectedKey, expected: archive.sha256, actual: metadata.sha256 || null });
    verified = false;
  }
  if (String(metadata.schema_version || "") !== rawSchemaVersion) {
    failures.add("r2_metadata_schema_mismatch", { key: expectedKey, expected: rawSchemaVersion, actual: metadata.schema_version || null });
    verified = false;
  }
  if (Number(head?.contentLength) !== archive.byte_size || body.byteLength !== archive.byte_size) {
    failures.add("r2_byte_size_mismatch", {
      key: expectedKey,
      expected: archive.byte_size,
      head_content_length: Number(head?.contentLength ?? null),
      content_length: body.byteLength
    });
    verified = false;
  }
  if (verified) report.counts.r2_objects_verified += 1;

  let rows;
  try {
    rows = parseCsv(body.toString("utf8"));
  } catch (error) {
    failures.add("r2_csv_parse_failed", { key: expectedKey, code: safeErrorText(error) });
    return false;
  }
  if (rows.length !== archive.row_count) {
    failures.add("raw_row_count_mismatch", { key: expectedKey, expected: archive.row_count, actual: rows.length });
  }
  report.counts.raw_rows_processed += rows.length;

  const rowsById = new Map();
  for (const [index, row] of rows.entries()) {
    const ordinal = index + 1;
    try {
      const rawObservation = buildRawObservation(row, archive, ordinal);
      rowsById.set(rawObservation.raw_observation_id, { rawObservation, ordinal, row });
    } catch (error) {
      report.counts.normalization_failures += 1;
      failures.add("raw_row_invalid", { key: expectedKey, source_line_number: ordinal, code: safeErrorText(error) });
    }
  }
  const ids = [...rowsById.keys()];
  // Deterministic normalized key: hash(raw_observation_id:transformation_version) via
  // the owning 04d3 calculator; exact primary-key lookup, never a raw-id fold.
  const expectedNormalizedIds = new Map(ids.map((rawObservationId) => [
    rawObservationId,
    calculateNormalizedObservationId(rawObservationId, archive.transformation_version)
  ]));
  const normalizedIds = [...expectedNormalizedIds.values()];

  let fetched;
  try {
    fetched = await readers.database.withReadOnlyTransaction(async ({ query }) => ({
      references: await fetchByRawObservationIds(query, ids, batchSize),
      normalized: await fetchNormalizedByPrimaryKeys(query, normalizedIds, batchSize)
    }));
    auditedVersions.add(archive.transformation_version);
  } catch (error) {
    failures.add("audit_read_failed", { key: expectedKey, code: safeErrorText(error) });
    return true;
  }

  const referencesById = new Map(fetched.references.map((row) => [String(row.raw_observation_id), row]));
  const normalizedById = new Map();
  for (const row of fetched.normalized) {
    const normalizedId = String(row.normalized_observation_id || "");
    if (normalizedById.has(normalizedId)) {
      failures.add("normalized_duplicate_primary_key", {
        key: expectedKey,
        normalized_observation_id: normalizedId
      });
    }
    normalizedById.set(normalizedId, row);
  }

  for (const [rawObservationId, entry] of rowsById) {
    const expectedReference = buildArchiveLineReference(entry, archive, inventoryEntry.bucket);
    const reference = referencesById.get(rawObservationId);
    if (!reference) {
      report.counts.archive_line_references_missing += 1;
      failures.add("archive_line_reference_missing", { raw_observation_id: rawObservationId, key: expectedKey });
    } else {
      report.counts.archive_line_references_found += 1;
      const conflictingFields = REFERENCE_FIELDS.filter((field) =>
        field !== "raw_observation_id" && String(reference[field]) !== String(expectedReference[field])
      );
      if (conflictingFields.length > 0) {
        report.counts.archive_line_references_conflicting += 1;
        failures.add("archive_line_reference_conflict", {
          raw_observation_id: rawObservationId,
          fields: conflictingFields,
          expected: pickFields(expectedReference, conflictingFields),
          actual: pickFields(reference, conflictingFields)
        });
      }
    }

    const expectedNormalizedId = expectedNormalizedIds.get(rawObservationId);
    const normalized = normalizedById.get(expectedNormalizedId);
    if (!normalized) {
      report.counts.normalized_missing += 1;
      failures.add("normalized_observation_missing", {
        raw_observation_id: rawObservationId,
        normalized_observation_id: expectedNormalizedId,
        transformation_version: archive.transformation_version,
        key: expectedKey
      });
      continue;
    }
    report.counts.normalized_found += 1;

    const lineageConflicts = [];
    if (String(normalized.normalized_observation_id) !== expectedNormalizedId) lineageConflicts.push("normalized_observation_id");
    if (String(normalized.raw_observation_id) !== rawObservationId) lineageConflicts.push("raw_observation_id");
    if (String(normalized.contract_version) !== NORMALIZED_V2_VERSION) lineageConflicts.push("contract_version");
    if (lineageConflicts.length > 0) {
      failures.add("normalized_lineage_conflict", {
        raw_observation_id: rawObservationId,
        fields: lineageConflicts,
        expected: {
          normalized_observation_id: expectedNormalizedId,
          raw_observation_id: rawObservationId,
          contract_version: NORMALIZED_V2_VERSION
        },
        actual: pickFields(normalized, lineageConflicts)
      });
      continue;
    }

    const transformationVersion = String(normalized.transformation_version || "");
    if (transformationVersion !== archive.transformation_version) {
      failures.add("normalized_transformation_version_unexpected", {
        raw_observation_id: rawObservationId,
        normalized_observation_id: expectedNormalizedId,
        expected: archive.transformation_version,
        actual: transformationVersion || null
      });
      continue;
    }
    if (!isUtcDateTime(String(normalized.generated_at || ""))) {
      failures.add("normalized_generated_at_invalid", {
        raw_observation_id: rawObservationId,
        normalized_observation_id: expectedNormalizedId,
        generated_at: normalized.generated_at ?? null
      });
    }

    const accessMode = accessMappings.byKey.get(accessMappingKey(entry.rawObservation.park_id, entry.rawObservation.ride_id));
    if (!accessMode) {
      report.counts.access_modes_missing += 1;
      failures.add("access_mode_mapping_missing", {
        raw_observation_id: rawObservationId,
        park_id: entry.rawObservation.park_id,
        ride_id: entry.rawObservation.ride_id
      });
      continue;
    }

    let recomputed;
    try {
      recomputed = normalizeArchivedWaitObservation({
        rawObservation: entry.rawObservation,
        archiveLineReference: expectedReference,
        catalogEntries: catalogSnapshot.entries,
        accessMode,
        generatedAt: checkedAt,
        transformationVersion: archive.transformation_version
      });
    } catch (error) {
      const category = normalizationFailureCategory(error);
      if (category === "canonical_identity_unresolved") report.counts.canonical_unresolved += 1;
      else report.counts.normalization_failures += 1;
      failures.add(category, { raw_observation_id: rawObservationId, code: safeErrorText(error) });
      continue;
    }

    const mismatchedFields = NORMALIZED_SEMANTIC_FIELDS.filter((field) =>
      JSON.stringify(normalized[field]) !== JSON.stringify(recomputed[field])
    );
    if (mismatchedFields.length > 0) {
      report.counts.normalized_semantic_mismatches += 1;
      failures.add("normalized_retry_conflict", {
        raw_observation_id: rawObservationId,
        normalized_observation_id: expectedNormalizedId,
        fields: mismatchedFields,
        expected: pickFields(recomputed, mismatchedFields),
        actual: pickFields(normalized, mismatchedFields)
      });
    }
  }
  return false;
}

function checkSourceHealth(report, runs, healthRecords, failures) {
  const healthByComposite = new Map();
  for (const record of healthRecords) {
    const sourceName = String(record.source_name || "");
    const runId = String(record.run_id || "");
    const key = sourceHealthKey(sourceName, runId);
    if (healthByComposite.has(key)) {
      report.source_health.duplicate_runs += 1;
      failures.add("source_health_duplicate_row", { source_name: sourceName, run_id: runId });
    }
    healthByComposite.set(key, record);
  }
  report.source_health.expected_runs = runs.length;
  for (const run of runs) {
    const runId = String(run.run_id);
    if (run.status !== "written") {
      failures.add("git_run_not_written", { source_name: run.source_name, run_id: runId, status: run.status });
    }
    // Composite identity: a health row must match both source_name and run_id.
    const health = healthByComposite.get(sourceHealthKey(run.source_name, runId));
    if (!health) {
      report.source_health.missing_runs += 1;
      failures.add("source_health_run_missing", { source_name: run.source_name, run_id: runId });
      continue;
    }
    if (health.source_status === "outage") {
      report.source_health.outage_runs += 1;
      failures.add("source_health_outage", { source_name: run.source_name, run_id: runId });
    } else if (health.source_status === "stale") {
      report.source_health.stale_runs += 1;
      failures.add("source_health_stale", { source_name: run.source_name, run_id: runId });
    }
    const issues = [];
    if (String(health.payload_sha256 || "") !== run.payload_sha256) issues.push("payload_sha256");
    if (Number(health.record_count) !== run.record_count) issues.push("record_count");
    if (health.fallback_status !== "written") issues.push("fallback_status");
    if (health.hosted_write_status !== "written") issues.push("hosted_write_status");
    if (run.adapter_version !== null && String(health.adapter_version || "") !== run.adapter_version) {
      issues.push("adapter_version");
    }
    if (run.schema_version !== null && String(health.schema_version || "") !== run.schema_version) {
      issues.push("schema_version");
    }
    if (run.deduplication_key !== null && String(health.envelope_id || "") !== run.deduplication_key) {
      issues.push("envelope_id");
    }
    if (issues.length > 0) {
      report.source_health.mismatched_runs += 1;
      failures.add("source_health_run_mismatch", { source_name: run.source_name, run_id: runId, fields: issues });
    } else if (health.source_status === "ok") {
      report.source_health.matched_runs += 1;
    }
  }
  report.source_health.failed_runs = report.source_health.expected_runs - report.source_health.matched_runs;
}

function checkRawBaseline(report, baseline, countsBefore, countsAfter, failures) {
  report.raw_baseline.supplied = true;
  report.raw_baseline.expected = expectedBaseline(baseline);
  report.raw_baseline.observed = {
    archives: countsAfter.raw_archives,
    raw_observations: countsAfter.raw_observations
  };
  const unchanged = countsAfter.raw_archives === baseline.archives &&
    countsAfter.raw_observations === baseline.raw_observations;
  report.raw_baseline.unchanged = unchanged;
  report.raw_baseline.new_raw_rows = Math.max(0, countsAfter.raw_observations - baseline.raw_observations);
  if (countsAfter.raw_observations > baseline.raw_observations || countsAfter.raw_archives > baseline.archives) {
    failures.add("raw_baseline_growth", {
      expected: expectedBaseline(baseline),
      observed: report.raw_baseline.observed,
      new_raw_rows: report.raw_baseline.new_raw_rows
    });
  } else if (!unchanged) {
    failures.add("raw_baseline_mismatch", {
      expected: expectedBaseline(baseline),
      observed: report.raw_baseline.observed
    });
  }
  if (countsBefore.raw_observations !== countsAfter.raw_observations ||
      countsBefore.raw_archives !== countsAfter.raw_archives) {
    failures.add("raw_baseline_changed_during_audit", {
      before: { archives: countsBefore.raw_archives, raw_observations: countsBefore.raw_observations },
      after: { archives: countsAfter.raw_archives, raw_observations: countsAfter.raw_observations }
    });
  }
}

async function loadR2Inventory(r2, archives) {
  const expectedKeys = new Map(archives.map((archive) => [expectedObjectKey(archive), archive]));
  const listed = await r2.listObjects({ prefix: R2_PREFIX });
  const byKey = new Map();
  const extras = [];
  const invalidEntries = [];
  for (const object of listed) {
    const key = String(object?.key || "");
    const listedBucket = typeof object?.bucket === "string" ? object.bucket.trim() : "";
    const size = Number(object?.size);
    if (!key || !listedBucket || !Number.isSafeInteger(size) || size < 0) {
      invalidEntries.push({ key: key || null, bucket: listedBucket || null });
      continue;
    }
    if (expectedKeys.has(key)) {
      byKey.set(key, { key, bucket: listedBucket, size });
    } else {
      extras.push(key);
    }
  }
  return { objects: listed, byKey, extras, invalidEntries };
}

function applyInventory(report, archives, inventory, failures, sampleLimit) {
  report.counts.r2_objects_listed = inventory.objects.length;
  report.counts.r2_objects_matched = inventory.byKey.size;
  report.counts.r2_objects_extra = inventory.extras.length;
  report.inventory.git_archive_count = archives.length;
  report.inventory.r2_object_count = inventory.objects.length;
  report.inventory.matched = inventory.byKey.size;
  report.inventory.extra = inventory.extras.length;
  report.inventory.missing = archives.length - inventory.byKey.size;
  report.inventory.samples = inventory.extras.slice(0, sampleLimit);
  report.inventory.status = report.inventory.extra === 0 && report.inventory.missing === 0 &&
    inventory.invalidEntries.length === 0
    ? "complete"
    : "incomplete";
  for (const key of inventory.extras) {
    failures.add("r2_extra_object", { key });
  }
  for (const entry of inventory.invalidEntries) {
    failures.add("r2_inventory_entry_invalid", entry);
  }
}

function missingRequiredRelations(schema) {
  return REQUIRED_RELATIONS
    .map(([, relation]) => relation)
    .filter((relation) => !schema.present.includes(relation));
}

function applyCounts(counts, dbCounts) {
  counts.db_raw_archives = dbCounts.raw_archives;
  counts.db_raw_observations = dbCounts.raw_observations;
  counts.db_normalized_v2 = dbCounts.normalized_v2;
  counts.db_archive_line_references = dbCounts.archive_line_references;
  counts.db_catalog_entries = dbCounts.catalog_entries;
  counts.db_source_health = dbCounts.source_health;
}

function validateCapacityEvidence(capacity, { checkedAt, targetFingerprint }) {
  if (!capacity || typeof capacity !== "object" || Array.isArray(capacity)) {
    return { ok: false, code: "capacity_measurement_required", report: null };
  }
  const report = {
    measurement_id: String(capacity.measurementId || ""),
    measured_at: String(capacity.measuredAt || ""),
    used_bytes: Number(capacity.usedBytes),
    max_capacity_bytes: Number(capacity.maxCapacityBytes),
    stop_threshold_bytes: Number(capacity.stopThresholdBytes),
    reserved_headroom_bytes: Number(capacity.reservedHeadroomBytes),
    target_fingerprint: String(capacity.targetFingerprint || ""),
    within_threshold: false,
    remaining_to_stop_bytes: 0,
    fresh: false
  };
  const structurallyValid =
    report.measurement_id.length > 0 &&
    isDateTime(report.measured_at) &&
    Number.isSafeInteger(report.used_bytes) && report.used_bytes >= 0 &&
    Number.isSafeInteger(report.max_capacity_bytes) && report.max_capacity_bytes > 0 &&
    Number.isSafeInteger(report.stop_threshold_bytes) && report.stop_threshold_bytes > 0 &&
    Number.isSafeInteger(report.reserved_headroom_bytes) && report.reserved_headroom_bytes >= 0 &&
    SHA256.test(report.target_fingerprint);
  if (!structurallyValid) {
    return { ok: false, code: "capacity_measurement_invalid", report: null };
  }
  report.remaining_to_stop_bytes = report.stop_threshold_bytes - report.used_bytes;
  report.within_threshold = report.used_bytes <= report.max_capacity_bytes &&
    report.used_bytes < report.stop_threshold_bytes;
  if (report.stop_threshold_bytes > report.max_capacity_bytes) {
    return { ok: false, code: "capacity_measurement_invalid", report };
  }
  // Required headroom: the stop threshold must stay below max minus reserved headroom.
  if (report.stop_threshold_bytes > report.max_capacity_bytes - report.reserved_headroom_bytes) {
    return { ok: false, code: "capacity_headroom_violated", report };
  }
  if (report.used_bytes > report.max_capacity_bytes) {
    return { ok: false, code: "capacity_exceeds_max_capacity", report };
  }
  if (report.used_bytes >= report.stop_threshold_bytes) {
    return { ok: false, code: "capacity_stop_threshold_reached", report };
  }
  const measuredAtMs = Date.parse(report.measured_at);
  const checkedAtMs = Date.parse(checkedAt);
  if (measuredAtMs > checkedAtMs) {
    return { ok: false, code: "capacity_measurement_future", report };
  }
  if (checkedAtMs - measuredAtMs > maximumCapacityMeasurementAgeMs) {
    return { ok: false, code: "capacity_measurement_stale", report };
  }
  if (targetFingerprint && report.target_fingerprint !== targetFingerprint) {
    return { ok: false, code: "capacity_target_fingerprint_mismatch", report };
  }
  report.fresh = true;
  return { ok: true, code: null, report };
}

function validateCatalogSnapshot(catalogSnapshot) {
  const blockers = [];
  if (!catalogSnapshot || catalogSnapshot.status !== "reviewed" ||
      !isNonEmptyString(catalogSnapshot.catalog_version) ||
      !isNonEmptyString(catalogSnapshot.reviewed_by) ||
      !isDateTime(catalogSnapshot.reviewed_at) ||
      !Array.isArray(catalogSnapshot.entries) || catalogSnapshot.entries.length === 0) {
    blockers.push("reviewed_catalog_entry_v1_snapshot_required");
    return blockers;
  }
  let entriesValid = true;
  for (const [index, entry] of catalogSnapshot.entries.entries()) {
    try {
      if (entry?.contract_version !== "catalog-entry.v1" ||
          entry.lifecycle?.catalog_version !== catalogSnapshot.catalog_version) {
        throw new Error("catalog snapshot version mismatch");
      }
      resolveCanonicalAttraction({
        parkId: entry.park_id,
        sourceAttractionName: entry.aliases?.[0],
        catalogEntries: [entry],
        asOfDate: entry.lifecycle?.valid_from
      });
    } catch {
      entriesValid = false;
      blockers.push(`invalid_reviewed_catalog_entry_${index}`);
    }
  }
  // Fail the whole reviewed scope when two lifecycle-overlapping entries in one
  // park can resolve the same alias to different canonical IDs; reuse the owning
  // resolver instead of inferring a winner.
  if (entriesValid && hasCrossEntryAliasAmbiguity(catalogSnapshot.entries)) {
    blockers.push("reviewed_catalog_snapshot_cross_entry_alias_ambiguity");
  }
  return blockers;
}

function hasCrossEntryAliasAmbiguity(entries) {
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const left = entries[leftIndex];
      const right = entries[rightIndex];
      if (left.park_id !== right.park_id ||
          left.canonical_attraction_id === right.canonical_attraction_id ||
          !lifecyclesOverlap(left.lifecycle, right.lifecycle)) {
        continue;
      }
      const asOfDate = left.lifecycle.valid_from > right.lifecycle.valid_from
        ? left.lifecycle.valid_from
        : right.lifecycle.valid_from;
      for (const alias of [...left.aliases, ...right.aliases]) {
        try {
          resolveCanonicalAttraction({
            parkId: left.park_id,
            sourceAttractionName: alias,
            catalogEntries: entries,
            asOfDate
          });
        } catch (error) {
          if (error?.code === "AMBIGUOUS_CANONICAL_ATTRACTION") return true;
        }
      }
    }
  }
  return false;
}

function lifecyclesOverlap(left, right) {
  const leftEnd = left.valid_to === null ? "9999-12-31" : left.valid_to;
  const rightEnd = right.valid_to === null ? "9999-12-31" : right.valid_to;
  return left.valid_from < rightEnd && right.valid_from < leftEnd;
}

function validateAccessModeMapping(accessModeMapping, catalogSnapshot) {
  const blockers = [];
  const byKey = new Map();
  if (!accessModeMapping || accessModeMapping.status !== "reviewed" ||
      !isNonEmptyString(accessModeMapping.catalog_version) ||
      !isNonEmptyString(accessModeMapping.reviewed_by) ||
      !isDateTime(accessModeMapping.reviewed_at) ||
      !Array.isArray(accessModeMapping.mappings) ||
      accessModeMapping.catalog_version !== catalogSnapshot?.catalog_version) {
    blockers.push("reviewed_structured_access_mode_mapping_required");
    return { blockers, byKey };
  }
  for (const [index, mapping] of accessModeMapping.mappings.entries()) {
    if (!hasOnlyKeys(mapping, ["park_id", "ride_id", "access_mode"]) ||
        !isNonEmptyString(mapping?.park_id) || !isNonEmptyString(mapping?.ride_id) ||
        !["standby", "single_rider", "virtual_queue", "other"].includes(mapping?.access_mode)) {
      blockers.push(`invalid_access_mode_mapping_${index}`);
      continue;
    }
    const key = accessMappingKey(mapping.park_id, mapping.ride_id);
    if (byKey.has(key)) {
      // One (park_id, ride_id) must map to exactly one reviewed access mode.
      blockers.push(`duplicate_access_mode_mapping_${index}`);
      continue;
    }
    byKey.set(key, mapping.access_mode);
  }
  return { blockers, byKey };
}

function normalizeGitInventory(git) {
  const blockers = [];
  const result = {
    archives: [],
    runs: [],
    historyCount: 0,
    liveCount: 0,
    duplicateArchives: 0,
    duplicateRuns: 0,
    retriedRuns: 0,
    rawRowsExpected: 0,
    normalizedExpected: 0,
    versions: []
  };
  if (!git || typeof git !== "object" || Array.isArray(git)) {
    result.blockers = ["git_archive_evidence_missing", "git_run_evidence_missing"];
    return result;
  }
  if (git.historyError) blockers.push("git_history_inventory_unavailable");
  if (git.liveError) blockers.push("git_live_inventory_unavailable");

  const archiveInputs = [
    ...(Array.isArray(git.historyArchives) ? git.historyArchives.map((value) => ({ value, origin: "history" })) : []),
    ...(Array.isArray(git.liveArchives) ? git.liveArchives.map((value) => ({ value, origin: "live" })) : []),
    ...(Array.isArray(git.archives) ? git.archives.map((value) => ({ value, origin: "auto" })) : [])
  ];
  const archivesBySha = new Map();
  for (const { value, origin } of archiveInputs) {
    const normalized = normalizeArchiveEvidence(value, origin);
    if (normalized.error) {
      blockers.push(normalized.error);
      continue;
    }
    const descriptor = normalized.descriptor;
    const existing = archivesBySha.get(descriptor.raw_archive_id);
    if (!existing) {
      archivesBySha.set(descriptor.raw_archive_id, descriptor);
      continue;
    }
    if (existing.source_name !== descriptor.source_name ||
        existing.byte_size !== descriptor.byte_size ||
        existing.row_count !== descriptor.row_count ||
        existing.transformation_version !== descriptor.transformation_version) {
      blockers.push("git_archive_evidence_conflict");
      continue;
    }
    for (const runId of descriptor.run_ids) {
      if (!existing.run_ids.includes(runId)) existing.run_ids.push(runId);
    }
    result.duplicateArchives += 1;
  }
  result.archives = [...archivesBySha.values()];

  const runInputs = Array.isArray(git.runs) ? git.runs : [];
  if (runInputs.length === 0) blockers.push("git_run_evidence_missing");
  const runsById = new Map();
  for (const value of runInputs) {
    const normalized = normalizeRunEvidence(value);
    if (normalized.error) {
      blockers.push(normalized.error);
      continue;
    }
    const run = normalized.run;
    const existing = runsById.get(run.run_id);
    if (existing) {
      if (canonicalJson(existing) === canonicalJson(run)) result.duplicateRuns += 1;
      else blockers.push("duplicate_git_run_evidence");
      continue;
    }
    runsById.set(run.run_id, run);
  }
  result.runs = [...runsById.values()];

  const historyArchives = result.archives.filter((archive) =>
    archive.transformation_version === HISTORY_TRANSFORMATION_VERSION);
  const liveArchives = result.archives.filter((archive) =>
    archive.transformation_version === LIVE_TRANSFORMATION_VERSION);
  result.historyCount = historyArchives.length;
  result.liveCount = liveArchives.length;
  if (historyArchives.length === 0) blockers.push("git_history_archive_evidence_missing");
  if (liveArchives.length === 0) blockers.push("git_live_archive_evidence_missing");

  const liveBySha = new Map(liveArchives.map((archive) => [archive.raw_archive_id, archive]));
  for (const run of result.runs) {
    const archive = liveBySha.get(run.payload_sha256);
    if (!archive) {
      blockers.push("live_run_archive_evidence_missing");
      continue;
    }
    if (archive.row_count !== run.record_count) blockers.push("live_run_archive_conflict");
  }
  for (const archive of liveArchives) {
    for (const runId of archive.run_ids) {
      const run = runsById.get(runId);
      if (!run) {
        blockers.push("live_archive_run_link_missing");
        continue;
      }
      if (run.payload_sha256 !== archive.raw_archive_id) blockers.push("live_archive_run_link_conflict");
    }
  }
  for (const run of result.runs) {
    if (run.retry_of !== null) {
      const target = runsById.get(run.retry_of);
      if (!target || target.payload_sha256 !== run.payload_sha256) {
        blockers.push("live_run_retry_evidence_invalid");
        continue;
      }
      result.retriedRuns += 1;
    } else if (run.r2_object_created === false) {
      result.retriedRuns += 1;
    }
  }

  result.rawRowsExpected = result.archives.reduce((total, archive) => total + archive.row_count, 0);
  // Every descriptor carries exactly one expected transformation version, so each
  // archive row is expected to have exactly one normalized primary key.
  result.normalizedExpected = result.rawRowsExpected;
  result.versions = [...new Set(result.archives.map((archive) => archive.transformation_version))].sort();
  result.blockers = blockers;
  return result;
}

function normalizeArchiveEvidence(value, origin) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "git_archive_descriptor_invalid" };
  }
  const declaredId = value.raw_archive_id === undefined || value.raw_archive_id === null
    ? null
    : String(value.raw_archive_id);
  const declaredSha = value.sha256 === undefined || value.sha256 === null ? null : String(value.sha256);
  const sha = declaredId || declaredSha || "";
  if (!SHA256.test(sha) || (declaredId !== null && declaredSha !== null && declaredId !== declaredSha)) {
    return { error: "git_archive_descriptor_invalid" };
  }
  if (!isNonEmptyString(value.source_name) || /[\\/]/.test(value.source_name)) {
    return { error: "git_archive_descriptor_invalid" };
  }
  if (!Number.isSafeInteger(value.byte_size) || value.byte_size <= 0) {
    return { error: "git_archive_descriptor_invalid" };
  }
  if (!Number.isSafeInteger(value.row_count) || value.row_count <= 0) {
    return { error: "git_archive_descriptor_invalid" };
  }
  const transformationVersion = value.transformation_version;
  if (!EXPECTED_TRANSFORMATION_VERSIONS.includes(transformationVersion)) {
    return { error: "git_archive_transformation_version_invalid" };
  }
  if ((origin === "history" && transformationVersion !== HISTORY_TRANSFORMATION_VERSION) ||
      (origin === "live" && transformationVersion !== LIVE_TRANSFORMATION_VERSION)) {
    return { error: "git_archive_transformation_version_mismatch" };
  }
  let runIds = [];
  if (transformationVersion === LIVE_TRANSFORMATION_VERSION) {
    if (Array.isArray(value.run_ids)) runIds = value.run_ids.filter(isNonEmptyString);
    else if (isNonEmptyString(value.run_id)) runIds = [value.run_id];
    if (runIds.length === 0) return { error: "git_live_archive_run_link_missing" };
  }
  return {
    descriptor: {
      raw_archive_id: sha,
      sha256: sha,
      source_name: value.source_name,
      byte_size: value.byte_size,
      row_count: value.row_count,
      transformation_version: transformationVersion,
      run_ids: runIds
    }
  };
}

function normalizeRunEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "git_run_descriptor_invalid" };
  }
  const runId = typeof value.run_id === "string" ? value.run_id.trim() : "";
  if (!runId) return { error: "git_run_descriptor_invalid" };
  if (!isNonEmptyString(value.source_name)) return { error: "git_run_source_name_required" };
  if (!isNonEmptyString(value.status)) return { error: "git_run_descriptor_invalid" };
  const payloadSha256 = String(value.payload_sha256 || value.deduplication_key || "");
  if (!SHA256.test(payloadSha256)) return { error: "git_run_descriptor_invalid" };
  if (!Number.isSafeInteger(value.record_count) || value.record_count < 0) {
    return { error: "git_run_descriptor_invalid" };
  }
  const observedAt = value.observed_at === undefined || value.observed_at === null
    ? null
    : String(value.observed_at);
  if (observedAt !== null && !isDateTime(observedAt)) return { error: "git_run_descriptor_invalid" };
  const deduplicationKey = value.deduplication_key === undefined || value.deduplication_key === null
    ? null
    : String(value.deduplication_key);
  if (deduplicationKey !== null && !SHA256.test(deduplicationKey)) {
    return { error: "git_run_descriptor_invalid" };
  }
  const adapterVersion = value.adapter_version === undefined || value.adapter_version === null
    ? null
    : String(value.adapter_version);
  if (adapterVersion !== null && !isNonEmptyString(adapterVersion)) {
    return { error: "git_run_descriptor_invalid" };
  }
  const schemaVersion = value.schema_version === undefined || value.schema_version === null
    ? null
    : String(value.schema_version);
  if (schemaVersion !== null && !isNonEmptyString(schemaVersion)) {
    return { error: "git_run_descriptor_invalid" };
  }
  if (value.r2_object_created !== undefined && value.r2_object_created !== null &&
      typeof value.r2_object_created !== "boolean") {
    return { error: "git_run_descriptor_invalid" };
  }
  const retryOf = value.retry_of === undefined || value.retry_of === null ? null : String(value.retry_of);
  if (retryOf !== null && retryOf.trim() === "") return { error: "git_run_descriptor_invalid" };
  return {
    run: {
      run_id: runId,
      source_name: value.source_name,
      status: value.status,
      payload_sha256: payloadSha256,
      record_count: value.record_count,
      observed_at: observedAt,
      deduplication_key: deduplicationKey,
      adapter_version: adapterVersion,
      schema_version: schemaVersion,
      r2_object_created: value.r2_object_created ?? null,
      retry_of: retryOf
    }
  };
}

function buildTargetEvidence({ targetName, targetFingerprint, authorization }) {
  if (!targetName || !targetFingerprint ||
      !authorization || authorization.kind !== "read-only-validation" ||
      !isNonEmptyString(authorization.approvedBy) ||
      !isDateTime(authorization.approvedAt) || !isDateTime(authorization.expiresAt)) {
    return null;
  }
  return {
    name: targetName,
    fingerprint: targetFingerprint,
    authorization: {
      kind: "read-only-validation",
      approved_by: authorization.approvedBy,
      approved_at: authorization.approvedAt,
      expires_at: authorization.expiresAt
    }
  };
}

function createReportBase({ mode, checkedAt, runId, catalogVersion, transformationVersions }) {
  return {
    contract_version: hostedNormalizedAuditContractVersion,
    run_id: runId,
    checked_at: checkedAt,
    status: "blocked",
    read_only: true,
    mode,
    connections_opened: false,
    complete: false,
    target: null,
    versions: {
      audit_adapter_version: hostedNormalizedAuditAdapterVersion,
      raw_schema_version: rawSchemaVersion,
      normalized_schema_version: NORMALIZED_V2_VERSION,
      archive_reference_version: ARCHIVE_REFERENCE_VERSION,
      source_health_version: sourceHealthVersion,
      catalog_version: catalogVersion ?? null,
      transformation_versions: [...(transformationVersions || [])],
      audited_transformation_versions: []
    },
    counts: {
      git_archives: 0,
      git_history_archives: 0,
      git_live_archives: 0,
      git_runs: 0,
      r2_objects_listed: 0,
      r2_objects_matched: 0,
      r2_objects_extra: 0,
      r2_objects_verified: 0,
      raw_rows_expected: 0,
      raw_rows_processed: 0,
      archive_line_references_found: 0,
      archive_line_references_missing: 0,
      archive_line_references_conflicting: 0,
      normalized_expected: 0,
      normalized_found: 0,
      normalized_missing: 0,
      normalized_semantic_mismatches: 0,
      canonical_unresolved: 0,
      access_modes_missing: 0,
      normalization_failures: 0,
      db_raw_archives: 0,
      db_raw_observations: 0,
      db_normalized_v2: 0,
      db_archive_line_references: 0,
      db_catalog_entries: 0,
      db_source_health: 0
    },
    source_health: {
      expected_runs: 0,
      matched_runs: 0,
      missing_runs: 0,
      failed_runs: 0,
      outage_runs: 0,
      stale_runs: 0,
      mismatched_runs: 0,
      duplicate_runs: 0,
      retried_runs: 0
    },
    raw_baseline: {
      supplied: false,
      expected: null,
      observed: null,
      unchanged: null,
      new_raw_rows: null
    },
    capacity: null,
    inventory: {
      status: "not_checked",
      git_archive_count: 0,
      r2_object_count: 0,
      matched: 0,
      extra: 0,
      missing: 0,
      samples: []
    },
    failures: [],
    blockers: [],
    next_steps: []
  };
}

function createFailureCollector(limit) {
  const entries = new Map();
  return {
    add(category, sample) {
      const entry = entries.get(category) || {
        category,
        count: 0,
        included_count: 0,
        omitted_count: 0,
        samples: []
      };
      entry.count += 1;
      if (sample && entry.samples.length < limit) {
        entry.samples.push(sanitizeDiagnostic(sample));
        entry.included_count = entry.samples.length;
      }
      entry.omitted_count = entry.count - entry.included_count;
      entries.set(category, entry);
    },
    toArray() {
      return [...entries.values()].sort((left, right) => left.category.localeCompare(right.category));
    }
  };
}

async function loadSchemaPresence(query) {
  const result = await query(
    `SELECT ${REQUIRED_RELATIONS.map(([alias], index) => `to_regclass($${index + 1}) AS ${alias}`).join(", ")}`,
    REQUIRED_RELATIONS.map(([, relation]) => relation)
  );
  const row = result.rows?.[0] || {};
  return {
    present: REQUIRED_RELATIONS.filter(([alias]) => row[alias]).map(([, relation]) => relation)
  };
}

async function loadCounts(query) {
  const result = await query(
    `SELECT
       (SELECT count(*)::bigint FROM ingestion.raw_archives) AS raw_archives,
       (SELECT count(*)::bigint FROM ingestion.raw_wait_observations) AS raw_observations,
       (SELECT count(*)::bigint FROM observations.normalized_wait_observations_v2) AS normalized_v2,
       (SELECT count(*)::bigint FROM ingestion.raw_archive_line_references) AS archive_line_references,
       (SELECT count(*)::bigint FROM catalog.catalog_entry_snapshots) AS catalog_entries,
       (SELECT count(*)::bigint FROM ingestion.source_health) AS source_health`
  );
  const row = result.rows?.[0] || {};
  return {
    raw_archives: Number(row.raw_archives || 0),
    raw_observations: Number(row.raw_observations || 0),
    normalized_v2: Number(row.normalized_v2 || 0),
    archive_line_references: Number(row.archive_line_references || 0),
    catalog_entries: Number(row.catalog_entries || 0),
    source_health: Number(row.source_health || 0)
  };
}

async function loadSourceHealth(query, pairs, batchSize) {
  if (pairs.length === 0) return [];
  const rows = [];
  for (let start = 0; start < pairs.length; start += batchSize) {
    const batch = pairs.slice(start, start + batchSize);
    const placeholders = batch.map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`).join(", ");
    const params = batch.flatMap(({ sourceName, runId }) => [sourceName, runId]);
    const result = await query(
      `SELECT source_name, run_id, source_status, payload_sha256, record_count,
              fallback_status, hosted_write_status, adapter_version, schema_version, envelope_id, error_type
         FROM ingestion.source_health
        WHERE (source_name, run_id) IN (${placeholders})`,
      params
    );
    rows.push(...(result.rows || []));
  }
  return rows;
}

async function fetchByRawObservationIds(query, ids, batchSize) {
  const rows = [];
  for (let start = 0; start < ids.length; start += batchSize) {
    const batch = ids.slice(start, start + batchSize);
    const result = await query(
      `SELECT ${REFERENCE_FIELDS.join(", ")}
         FROM ingestion.raw_archive_line_references
        WHERE raw_observation_id = ANY($1::text[])`,
      [batch]
    );
    rows.push(...(result.rows || []));
  }
  return rows;
}

async function fetchNormalizedByPrimaryKeys(query, normalizedIds, batchSize) {
  const rows = [];
  for (let start = 0; start < normalizedIds.length; start += batchSize) {
    const batch = normalizedIds.slice(start, start + batchSize);
    const result = await query(
      `SELECT ${NORMALIZED_FIELDS.join(", ")}
         FROM observations.normalized_wait_observations_v2
        WHERE normalized_observation_id = ANY($1::text[])`,
      [batch]
    );
    rows.push(...(result.rows || []).map(normalizeNormalizedRow));
  }
  return rows;
}

function normalizeNormalizedRow(row) {
  return {
    ...row,
    observed_at_utc: row.observed_at_utc instanceof Date ? row.observed_at_utc.toISOString() : String(row.observed_at_utc),
    generated_at: row.generated_at instanceof Date ? row.generated_at.toISOString() : String(row.generated_at),
    observed_wait_time_minutes: row.observed_wait_time_minutes === null || row.observed_wait_time_minutes === undefined
      ? null
      : Number(row.observed_wait_time_minutes),
    is_open: row.is_open === true || row.is_open === "true" || row.is_open === "t"
  };
}

function buildRawObservation(row, archive, ordinal) {
  const rawObservation = {
    contract_version: rawSchemaVersion,
    raw_observation_id: calculateRawObservationId(archive.sha256, ordinal),
    raw_archive_id: archive.raw_archive_id,
    source_row_number: ordinal,
    snapshot_utc: requiredCsvValue(row, "snapshot_utc"),
    snapshot_timezone: requiredCsvValue(row, "snapshot_timezone"),
    park_id: requiredCsvValue(row, "park_id"),
    ride_id: requiredCsvValue(row, "ride_id"),
    ride_name: requiredCsvValue(row, "ride_name"),
    is_open: parseBoolean(requiredCsvValue(row, "is_open")),
    source_last_updated_utc: requiredCsvValue(row, "source_last_updated_utc"),
    source_url: requiredCsvValue(row, "source_url")
  };
  for (const field of [
    "snapshot_park_datetime",
    "snapshot_park_date",
    "park_name",
    "land",
    "source_last_updated_park_datetime"
  ]) {
    if (row[field] !== undefined && row[field] !== "") rawObservation[field] = row[field];
  }
  if (Object.hasOwn(row, "wait_time_minutes")) {
    rawObservation.wait_time_minutes = parseNullableWait(row.wait_time_minutes);
  }
  return rawObservation;
}

function buildArchiveLineReference(entry, archive, bucket) {
  return {
    contract_version: ARCHIVE_REFERENCE_VERSION,
    raw_observation_id: entry.rawObservation.raw_observation_id,
    raw_archive_id: archive.raw_archive_id,
    r2_uri: `s3://${bucket}/${expectedObjectKey(archive)}`,
    archive_sha256: archive.sha256,
    archive_byte_size: archive.byte_size,
    source_line_number: entry.ordinal,
    source_name: archive.source_name,
    archive_schema_version: rawSchemaVersion
  };
}

function normalizationFailureCategory(error) {
  const code = String(error?.code || "");
  if (["UNKNOWN_CANONICAL_ATTRACTION", "AMBIGUOUS_CANONICAL_ATTRACTION", "CATALOG_LIFECYCLE_NOT_EFFECTIVE"].includes(code)) {
    return "canonical_identity_unresolved";
  }
  if (code === "PARK_TIMEZONE_MISMATCH" || code === "INVALID_TIMEZONE") return "normalized_timezone_mismatch";
  if (["INVALID_TIMESTAMP", "PARK_DATE_MISMATCH"].includes(code)) return "normalized_timestamp_invalid";
  return "normalization_failed";
}

function expectedObjectKey(archive) {
  return `${R2_PREFIX}${archive.sha256}/${archive.source_name}`;
}

function accessMappingKey(parkId, rideId) {
  return `${parkId}\u001f${rideId}`;
}

function sourceHealthKey(sourceName, runId) {
  return `${sourceName}\u001f${runId}`;
}

function isValidBaseline(baseline) {
  return Boolean(baseline) && typeof baseline === "object" && !Array.isArray(baseline) &&
    Number.isSafeInteger(baseline.archives) && baseline.archives >= 0 &&
    Number.isSafeInteger(baseline.raw_observations) && baseline.raw_observations >= 0 &&
    Number.isSafeInteger(baseline.normalized_observations) && baseline.normalized_observations >= 0;
}

function expectedBaseline(baseline) {
  return {
    archives: baseline.archives,
    raw_observations: baseline.raw_observations,
    normalized_observations: baseline.normalized_observations
  };
}

function blockedNextSteps() {
  return [
    "Obtain a current human-approved validation target and a read-only authorization bound to its host/port/database fingerprint; the prior validation branch expired 2026-09-30.",
    "Supply reviewed catalog-entry.v1 inputs, structured access-mode mapping, merged historical plus live Git archive evidence with run linkage, legacy raw baseline, and a fresh capacity measurement, then re-run the read-only audit."
  ];
}

function failedNextSteps() {
  return [
    "Resolve every listed mismatch or missing-evidence category and re-run the read-only audit before the human acceptance gate.",
    "Do not treat this report as validation acceptance and do not fall back to production."
  ];
}

function passedNextSteps() {
  return [
    "Retain this report with the target evidence as the read-only validation acceptance checkpoint.",
    "Proceed to the human acceptance gate; this audit does not clean data, apply migrations, or enable production writes."
  ];
}

function resolveCheckedAt(value, blockers) {
  if (value === undefined || value === null) return new Date().toISOString();
  if (!isUtcDateTime(value)) {
    blockers.push("checked_at_must_be_strict_utc");
    return new Date().toISOString();
  }
  return value;
}

function resolveRunId(value, blockers) {
  if (value === undefined || value === null) return randomUUID();
  if (!isNonEmptyString(value)) {
    blockers.push("audit_run_id_required");
    return randomUUID();
  }
  return value;
}

function requiredCsvValue(row, field) {
  const value = row?.[field];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`RAW_ROW_REQUIRED_FIELD_MISSING:${field}`);
  return value;
}

function parseBoolean(value) {
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  throw new Error("RAW_ROW_BOOLEAN_INVALID");
}

function parseNullableWait(value) {
  if (value === undefined || value === null || value === "") return null;
  if (!/^\d+$/.test(String(value))) throw new Error("RAW_ROW_WAIT_INVALID");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("RAW_ROW_WAIT_INVALID");
  return parsed;
}

function pickFields(source, fields) {
  const picked = {};
  for (const field of fields) picked[field] = source[field];
  return picked;
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function toBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hasOnlyKeys(value, allowedKeys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)) &&
    Object.keys(value).every((key) => allowedKeys.includes(key));
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isDateTime(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match || !isCalendarDate(match[1]) || Number(match[2]) > 23 ||
      Number(match[3]) > 59 || Number(match[4]) > 59 ||
      (match[6] && (Number(match[6]) > 23 || Number(match[7]) > 59))) return false;
  return !Number.isNaN(Date.parse(value));
}

function isUtcDateTime(value) {
  return isDateTime(value) && value.endsWith("Z");
}

function isCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function redactSecrets(value) {
  return String(value)
    .replace(/([a-z][a-z\d+.-]*:\/\/)([^/\s@]+)@/gi, "$1[redacted]@")
    .replace(/([?&](?:password|token|secret|key|access[_-]?key)\s*=)[^&\s]+/gi, "$1[redacted]");
}

function sanitizeDiagnostic(value) {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(sanitizeDiagnostic);
  if (value && typeof value === "object") {
    const sanitized = {};
    for (const [key, child] of Object.entries(value)) sanitized[key] = sanitizeDiagnostic(child);
    return sanitized;
  }
  return value;
}

function safeErrorText(error) {
  const code = typeof error?.code === "string" && /^[A-Za-z0-9_:-]{1,120}$/.test(error.code) ? error.code : null;
  const message = redactSecrets(String(error?.message || error || "unknown_error")).slice(0, 300);
  return code && !message.startsWith(code) ? `${code}:${message}` : message;
}

/** Keep the primary failure primary while retaining the secondary error. */
function attachSecondaryError(primaryError, property, secondaryError) {
  if (primaryError && typeof primaryError === "object") {
    try {
      Object.defineProperty(primaryError, property, {
        configurable: true,
        value: secondaryError
      });
      return primaryError;
    } catch {
      // Fall through to an aggregate that retains both errors.
    }
  }
  return new AggregateError(
    [primaryError, secondaryError],
    "Read-only audit operation and transaction rollback both failed.",
    { cause: primaryError }
  );
}

/* ------------------------------------------------------------------ */
/* Production adapters and CLI                                        */
/* ------------------------------------------------------------------ */

export async function createProductionAuditReaders({ environment = {}, databaseUrl, poolFactory } = {}) {
  const r2 = await createS3ReadOnlyAuditReader({ environment });
  const database = await createPostgresReadOnlyAuditReader({
    databaseUrl: databaseUrl || requiredEnvironment(environment.DATABASE_URL, "DATABASE_URL"),
    poolFactory
  });
  return { r2, database };
}

export async function createPostgresReadOnlyAuditReader({ databaseUrl, poolFactory } = {}) {
  if (typeof databaseUrl !== "string" || databaseUrl.trim() === "") {
    throw new Error("DATABASE_URL is required for a live read-only audit");
  }
  const createPool = poolFactory || (async (url) => {
    const { default: pg } = await import("pg");
    return new pg.Pool({ connectionString: url });
  });
  const pool = await createPool(databaseUrl);
  return {
    // Mirrors the 04d3 storage-transaction invariant: a failed BEGIN, or a failed
    // ROLLBACK, must destroy the client instead of returning a possibly dirty
    // connection, and rollback failures must not mask the primary operation error.
    // An operation failure may attempt exactly one rollback; the terminal rollback
    // after a successful operation is never retried.
    async withReadOnlyTransaction(operation) {
      const client = await pool.connect();
      let beginAttempted = false;
      let transactionOpen = false;
      let rollbackAttempted = false;
      let releaseError = null;
      try {
        beginAttempted = true;
        await client.query("BEGIN TRANSACTION READ ONLY");
        transactionOpen = true;
        const result = await operation({ query: (sql, params) => client.query(sql, params) });
        // Terminal rollback on the success path: exactly one attempt. A failure
        // leaves the transaction state uncertain, so destroy the client.
        rollbackAttempted = true;
        try {
          await client.query("ROLLBACK");
          transactionOpen = false;
        } catch (rollbackError) {
          releaseError = rollbackError;
          throw rollbackError;
        }
        return result;
      } catch (error) {
        let errorToThrow = error;
        if (transactionOpen && !rollbackAttempted) {
          rollbackAttempted = true;
          try {
            await client.query("ROLLBACK");
            transactionOpen = false;
          } catch (rollbackError) {
            errorToThrow = attachSecondaryError(error, "rollbackError", rollbackError);
            releaseError = rollbackError;
          }
        } else if (beginAttempted && !transactionOpen && !rollbackAttempted && releaseError === null) {
          // BEGIN failed or its outcome is unknown; never return this client to the pool.
          releaseError = error;
        }
        throw errorToThrow;
      } finally {
        if (releaseError) client.release?.(releaseError);
        else client.release?.();
      }
    },
    async close() {
      await pool.end().catch(() => {});
    }
  };
}

export async function createS3ReadOnlyAuditReader({ environment = {}, clientFactory } = {}) {
  const bucket = requiredEnvironment(environment.RAW_ARCHIVE_BUCKET, "RAW_ARCHIVE_BUCKET");
  const { HeadObjectCommand, GetObjectCommand, ListObjectsV2Command, S3Client } = await import("@aws-sdk/client-s3");
  const client = clientFactory
    ? await clientFactory({ environment, commands: { HeadObjectCommand, GetObjectCommand, ListObjectsV2Command, S3Client } })
    : new S3Client({
        region: environment.AWS_REGION || "us-west-2",
        endpoint: environment.RAW_ARCHIVE_ENDPOINT || undefined,
        forcePathStyle: Boolean(environment.RAW_ARCHIVE_ENDPOINT)
      });
  return {
    async listObjects({ prefix = R2_PREFIX } = {}) {
      const objects = [];
      let continuationToken;
      do {
        const response = await client.send(new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken
        }));
        for (const object of response.Contents || []) {
          objects.push({
            key: object.Key,
            bucket,
            size: Number(object.Size),
            etag: object.ETag || null,
            last_modified: object.LastModified?.toISOString?.() || null
          });
        }
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
      } while (continuationToken);
      return objects;
    },
    async headObject({ key }) {
      const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return {
        contentLength: Number(response.ContentLength),
        metadata: Object.fromEntries(
          Object.entries(response.Metadata || {}).map(([name, value]) => [name.toLowerCase(), value])
        )
      };
    },
    async getObject({ key }) {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const body = response.Body;
      if (!body) throw new Error("object response did not contain a body");
      if (typeof body.transformToByteArray === "function") return Buffer.from(await body.transformToByteArray());
      if (body[Symbol.asyncIterator]) {
        const chunks = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk));
        return Buffer.concat(chunks);
      }
      throw new Error("object response body is not readable");
    },
    async close() {
      // S3 clients expose no close(); kept for a uniform reader lifecycle.
    }
  };
}

async function loadLiveAuditInputs({ root, environment, checkedAt }) {
  const inputs = { targetName: environment.HOSTED_AUDIT_TARGET_NAME || "", databaseUrl: environment.DATABASE_URL || null };
  const readJson = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));
  for (const [key, envName] of [
    ["authorization", "HOSTED_AUDIT_AUTHORIZATION_PATH"],
    ["catalogSnapshot", "HOSTED_AUDIT_REVIEWED_CATALOG_PATH"],
    ["accessModeMapping", "HOSTED_AUDIT_ACCESS_MODE_MAPPING_PATH"],
    ["baseline", "HOSTED_AUDIT_BASELINE_PATH"],
    ["capacity", "HOSTED_AUDIT_CAPACITY_PATH"]
  ]) {
    const filePath = environment[envName];
    if (filePath) inputs[key] = await readJson(filePath);
  }

  const live = { runs: [], archives: [] };
  if (environment.HOSTED_AUDIT_RUNS_PATH) {
    const parsed = await readJson(environment.HOSTED_AUDIT_RUNS_PATH);
    if (Array.isArray(parsed)) {
      live.runs = parsed;
    } else if (parsed && typeof parsed === "object") {
      live.runs = Array.isArray(parsed.gitRuns) ? parsed.gitRuns : Array.isArray(parsed.runs) ? parsed.runs : [];
      live.archives = Array.isArray(parsed.gitArchives)
        ? parsed.gitArchives
        : Array.isArray(parsed.archives) ? parsed.archives : [];
    } else {
      inputs.gitLiveError = "HOSTED_AUDIT_RUNS_PATH must contain a run array or {gitRuns,gitArchives}";
    }
  }

  let historyArchives = [];
  let historyError = null;
  try {
    // Full-scope inventory: the R2 prefix is global, so date filtering here would
    // produce false extras. The audit always inventories the complete Git history.
    const plan = await buildBackfillPlan(root, { generatedAt: checkedAt });
    const rowsByArchive = new Map();
    for (const row of plan.rawRecords) {
      rowsByArchive.set(row.rawArchiveId, (rowsByArchive.get(row.rawArchiveId) || 0) + 1);
    }
    historyArchives = plan.archives.map((archive) => ({
      raw_archive_id: archive.rawArchiveId,
      sha256: archive.sha256,
      source_name: archive.sourceName,
      byte_size: archive.byteSize,
      row_count: rowsByArchive.get(archive.rawArchiveId) || 0,
      transformation_version: r2ReplayTransformationVersion
    }));
  } catch (error) {
    historyError = safeErrorText(error);
  }

  inputs.git = {
    runs: live.runs,
    liveArchives: live.archives,
    historyArchives,
    ...(historyError ? { historyError } : {}),
    ...(inputs.gitLiveError ? { liveError: inputs.gitLiveError } : {})
  };
  return inputs;
}

export async function runAuditCli(args, io = {}, deps = {}) {
  const writeStdout = io.writeStdout || ((text) => process.stdout.write(text));
  const writeStderr = io.writeStderr || ((text) => process.stderr.write(text));
  const environment = deps.environment || process.env;
  const flags = Array.isArray(args) ? args : [];

  const parsed = parseAuditCliArgs(flags);
  if (parsed.error) {
    writeStderr(`${parsed.error}\nUsage: node scripts/audit-hosted-normalized-persistence.mjs --check|--live\n`);
    return 2;
  }

  if (parsed.mode === "check") {
    const report = buildOfflineAuditReport({ checkedAt: deps.checkedAt, runId: deps.runId });
    writeStdout(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  const checkedAt = deps.checkedAt || new Date().toISOString();
  const runId = deps.runId || randomUUID();
  let inputs;
  try {
    inputs = await loadLiveAuditInputs({
      root: deps.root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
      environment,
      checkedAt
    });
  } catch (error) {
    inputs = { git: { archives: [], runs: [] }, liveInputsError: safeErrorText(error) };
  }

  const report = await runHostedNormalizedAudit({
    checkedAt,
    runId,
    mode: "live-read-only",
    ...inputs,
    readersFactory: deps.readersFactory || (() => createProductionAuditReaders({ environment, databaseUrl: inputs.databaseUrl })),
    diagnosticSampleLimit: deps.diagnosticSampleLimit,
    batchSize: deps.batchSize
  });
  writeStdout(`${JSON.stringify(report, null, 2)}\n`);
  return report.status === "passed" ? 0 : 1;
}

function parseAuditCliArgs(args) {
  let checkCount = 0;
  let liveCount = 0;
  for (const argument of args) {
    if (argument === "--check") {
      checkCount += 1;
    } else if (argument === "--live") {
      liveCount += 1;
    } else {
      // Including the removed --date flag: the R2 prefix is global, so date
      // scoping would hide false extras and must not be accepted.
      return { error: "unknown or ambiguous argument" };
    }
  }
  if (checkCount + liveCount !== 1) {
    return { error: "exactly one of --check or --live is required" };
  }
  return { mode: checkCount === 1 ? "check" : "live" };
}

function requiredEnvironment(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required for the live read-only audit`);
  }
  return value;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAuditCli(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(safeErrorText(error));
      process.exitCode = 1;
    });
}
