import { createHash, randomUUID } from "node:crypto";
import { resolveCanonicalAttraction } from "../../modules/catalog/index.mjs";
import { buildSourceHealthRecord } from "../../modules/ingestion/source-health.mjs";
import { normalizeArchivedWaitObservation } from "../../modules/observations/index.mjs";
import {
  calculateRawObservationId,
  createPostgresArchiveLineReferenceRepository
} from "../archive-line-reference-postgres.mjs";
import { createPostgresCatalogRepository } from "../catalog-postgres.mjs";
import {
  withPostgresStorageTransaction,
  createPostgresNormalizedObservationRepository
} from "../normalized-observations-postgres.mjs";
import { createPostgresSourceHealthRepository } from "../source-health-postgres.mjs";

export const r2ReplayReportVersion = "r2-normalized-replay-report.v1";
export const r2ReplayTransformationVersion = "r2-normalized-replay.v1";
export const r2ReplayAdapterVersion = "r2-normalized-replay-adapter.v1";

const RAW_SCHEMA_VERSION = "raw-wait-observation.v1";
const ARCHIVE_REFERENCE_VERSION = "raw-archive-line-reference.v1";
const ARCHIVE_DESCRIPTOR_FIELDS = new Set([
  "contract_version",
  "raw_archive_id",
  "sha256",
  "object_uri",
  "byte_size",
  "source_name",
  "schema_version"
]);
const SOURCE_ENVELOPE_VERSION = "source-envelope.v1";
const EXPECTED_TARGET_LABEL = "neon-validation-branch-only";
const CURRENT_PARK_IDS = new Set(["disneyland", "dca"]);
const ACCESS_MODES = new Set(["standby", "single_rider", "virtual_queue", "other"]);
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_DIAGNOSTIC_SAMPLES = 25;
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
export const maximumReplayBatchSize = 500;
export const maximumReplayBatchesPerInvocation = 20;
export const maximumReplayRowsPerInvocation = 10_000;
/** A capacity measurement older than this (or newer than generated_at) is not usable as a write gate. */
export const maximumCapacityMeasurementAgeMs = 24 * 60 * 60 * 1000;

const RAW_CSV_FIELDS = new Set([
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
]);
const RAW_CSV_REQUIRED_FIELDS = [
  "snapshot_utc",
  "snapshot_timezone",
  "park_id",
  "ride_id",
  "ride_name",
  "is_open",
  "source_last_updated_utc",
  "source_url"
];

/**
 * Bind replay writes to the existing 04d3 ports. `readOnlyQuery` must use a
 * read-only role; it is the only database interface used by dry-run/count checks.
 */
export function createPostgresR2ReplayDatabase({
  transactionPool,
  readOnlyQuery,
  targetLabel
} = {}) {
  if (!transactionPool || typeof transactionPool.connect !== "function") {
    throw new TypeError("transactionPool must expose connect()");
  }
  if (!readOnlyQuery || typeof readOnlyQuery.query !== "function") {
    throw new TypeError("readOnlyQuery must expose query() through a read-only database role");
  }

  return {
    targetLabel,
    async readRawObservationCount() {
      const result = await readOnlyQuery.query(
        "SELECT count(*)::bigint AS count FROM ingestion.raw_wait_observations"
      );
      const count = Number(result.rows?.[0]?.count);
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new TypeError("read-only raw observation count was not a non-negative safe integer");
      }
      return count;
    },
    async withTransaction(operation) {
      if (typeof operation !== "function") throw new TypeError("transaction operation must be a function");
      return withPostgresStorageTransaction(transactionPool, (client) => operation({
        archiveLines: createPostgresArchiveLineReferenceRepository(client),
        catalog: createPostgresCatalogRepository(client),
        normalized: createPostgresNormalizedObservationRepository(client),
        sourceHealth: createPostgresSourceHealthRepository(client)
      }));
    }
  };
}

/**
 * Preflight every selected immutable object and every row before the first write.
 * Write mode additionally requires an explicit validation-only authorization,
 * measured capacity gate, a live stop-threshold monitor, and finite batch limits.
 */
export async function replayR2ArchivesToNormalized(options = {}) {
  const inputOptions = options;
  const mode = options?.mode || "dry-run";
  const generatedAt = options?.generatedAt || new Date().toISOString();
  const report = createReplayReport({
    mode,
    runId: options?.runId || randomUUID(),
    generatedAt,
    targetLabel: options?.database?.targetLabel || null,
    archivesRequested: Array.isArray(options?.archives) ? options.archives.length : 0
  });
  try {
    options = snapshotReplayOptions(inputOptions);
  } catch {
    addBlocker(report, "replay_inputs_could_not_be_snapshotted");
    report.status = "blocked";
    return report;
  }
  const commonBlockers = validateCommonInputs(options, report);
  if (commonBlockers.length > 0) {
    report.blockers.push(...commonBlockers);
    report.status = "blocked";
    return report;
  }

  const reviewedInputs = validateReviewedInputs(options.catalogSnapshot, options.accessModeMapping);
  if (reviewedInputs.blockers.length > 0) {
    report.blockers.push(...reviewedInputs.blockers);
    report.status = "blocked";
    return report;
  }

  const { archives, invalidCount } = validateArchiveDescriptors(options.archives, report);
  if (archives.length === 0) {
    addBlocker(report, "no_valid_archive_descriptors");
    report.status = "blocked";
    return report;
  }

  const scopeId = calculateReplayScopeId({
    archives,
    catalogSnapshot: reviewedInputs.catalogSnapshot,
    accessModes: reviewedInputs.accessModes
  });
  report.scope_id = scopeId;

  // The scope_id always binds the full ordered inventory; only the cursor's
  // archive and later archives are read and normalized in this invocation.
  const cursorIdentity = validateResumeCursorIdentity(options.resumeFrom, scopeId, archives);
  if (cursorIdentity.error) {
    addBlocker(report, cursorIdentity.error);
    report.status = "blocked";
    return report;
  }
  const requestedCursor = cursorIdentity.value;
  const resumeArchiveIndex = requestedCursor === null
    ? 0
    : archives.findIndex(({ raw_archive_id }) => raw_archive_id === requestedCursor.raw_archive_id);
  const archivesSkippedBeforeCursor = archives.slice(0, resumeArchiveIndex);
  const archivesToPreflight = archives.slice(resumeArchiveIndex);
  report.resume = {
    resumed: requestedCursor !== null,
    cursor: requestedCursor ? { ...requestedCursor } : null,
    archives_skipped_before_cursor: archivesSkippedBeforeCursor.map(({ raw_archive_id }) => raw_archive_id),
    archives_preflighted_this_invocation: archivesToPreflight.map(({ raw_archive_id }) => raw_archive_id)
  };

  const preflight = await preflightArchives({
    archives: archivesToPreflight,
    r2: options.r2,
    catalogSnapshot: reviewedInputs.catalogSnapshot,
    accessModes: reviewedInputs.accessModes,
    generatedAt,
    report
  });
  if (invalidCount > 0 || hasPreflightIssues(report) ||
      report.counts.archives_verified !== archivesToPreflight.length ||
      report.counts.normalized_records_planned !== report.counts.data_rows) {
    report.status = "blocked";
    return report;
  }

  const cursor = validateResumeCursorRange(requestedCursor, preflight.archiveRowCounts);
  if (cursor.error) {
    addBlocker(report, cursor.error);
    report.status = "blocked";
    return report;
  }
  const rowsRemaining = countRowsFromCursor(archives, preflight.archiveRowCounts, cursor.value);
  report.counts.rows_remaining_from_cursor = rowsRemaining;
  report.next_cursor = cursor.value;

  let rawCountBefore;
  try {
    rawCountBefore = await readRawObservationCount(options.database);
  } catch {
    addDiagnostic(report, "runtime_failures", { code: "RAW_BASELINE_READ_FAILED", phase: "before" });
    report.status = "failed";
    return report;
  }
  report.raw_observation_baseline.before = rawCountBefore;

  if (mode === "dry-run") {
    const blockers = getWriteGateBlockers(options, rowsRemaining, report.generated_at);
    report.write_blockers.push(...blockers);
    try {
      const rawCountAfter = await readRawObservationCount(options.database);
      report.raw_observation_baseline.after = rawCountAfter;
      report.raw_observation_baseline.unchanged = rawCountBefore === rawCountAfter;
      if (rawCountBefore !== rawCountAfter) {
        addDiagnostic(report, "runtime_failures", { code: "RAW_BASELINE_CHANGED_DURING_DRY_RUN" });
        report.status = "failed";
        return report;
      }
    } catch {
      addDiagnostic(report, "runtime_failures", { code: "RAW_BASELINE_READ_FAILED", phase: "after_dry_run" });
      report.status = "failed";
      return report;
    }
    report.status = "dry_run_complete";
    return report;
  }

  if (rowsRemaining === 0) {
    report.raw_observation_baseline.after = rawCountBefore;
    report.raw_observation_baseline.unchanged = true;
    report.status = "completed";
    report.next_cursor = null;
    return report;
  }

  const writeGate = await validateWriteGate({
    options,
    rowsRemaining,
    report
  });
  if (writeGate.blockers.length > 0) {
    report.blockers.push(...writeGate.blockers);
    report.status = "blocked";
    await finishRawBaseline(options.database, report, rawCountBefore);
    return report;
  }
  report.capacity_gate = {
    measurement_id: options.capacityGate.measurementId,
    measured_at: options.capacityGate.measuredAt,
    stop_threshold_bytes: options.capacityGate.stopThresholdBytes,
    measured_used_bytes_before_replay: writeGate.currentUsedBytes,
    estimated_bytes_per_record: options.capacityGate.estimatedBytesPerRecord,
    preflight_status: "passed"
  };
  report.write_enabled = true;

  const execution = await executeBoundedReplay({
    options,
    archives,
    archiveRowCounts: preflight.archiveRowCounts,
    catalogSnapshot: reviewedInputs.catalogSnapshot,
    accessModes: reviewedInputs.accessModes,
    scopeId,
    cursor: cursor.value,
    rowsRemaining,
    report
  });
  report.status = execution.status;
  report.next_cursor = execution.nextCursor;
  if (execution.stopCode) report.stop_reason = execution.stopCode;
  await finishRawBaseline(options.database, report, rawCountBefore);
  if (report.raw_observation_baseline.unchanged !== true && report.status !== "failed") {
    report.status = "failed";
  }
  return report;
}

/** CLI-only check: intentionally does not inspect environment variables or open adapters. */
export function buildOfflineReplayCheckReport({ checkedAt = new Date().toISOString() } = {}) {
  return {
    contract_version: r2ReplayReportVersion,
    status: "blocked",
    mode: "offline_check",
    checked_at: checkedAt,
    write_requested: false,
    write_enabled: false,
    external_connections_opened: false,
    blockers: [
      "archive_inventory_and_r2_reader_not_injected",
      "reviewed_catalog_snapshot_not_supplied",
      "reviewed_structured_access_mode_mapping_not_supplied",
      "validation_target_unavailable_or_expired_as_of_2026-09-30",
      "measured_capacity_preflight_and_stop_threshold_not_supplied"
    ],
    counts: {
      archives_requested: 0,
      data_rows: 0,
      normalized_records_planned: 0,
      raw_observation_rows_written: 0
    },
    next_step: "Supply approved offline inputs and gates to the injected replay API; do not use production as a fallback."
  };
}

function createReplayReport({ mode, runId, generatedAt, targetLabel, archivesRequested }) {
  return {
    contract_version: r2ReplayReportVersion,
    status: "blocked",
    mode,
    run_id: runId,
    generated_at: generatedAt,
    target_label: targetLabel,
    scope_id: null,
    write_requested: mode === "write",
    write_enabled: false,
    counts: {
      archives_requested: archivesRequested,
      archives_verified: 0,
      data_rows: 0,
      normalized_records_planned: 0,
      rows_remaining_from_cursor: 0,
      unresolved_identities: 0,
      missing_access_modes: 0,
      archive_failures: 0,
      normalization_failures: 0,
      runtime_failures: 0,
      batches_committed: 0,
      normalized_records_committed: 0,
      raw_observation_rows_written: 0
    },
    diagnostics: {
      unresolved_identities: { count: 0, samples: [] },
      missing_access_modes: { count: 0, samples: [] },
      archive_failures: { count: 0, samples: [] },
      normalization_failures: { count: 0, samples: [] },
      runtime_failures: { count: 0, samples: [] }
    },
    blockers: [],
    write_blockers: [],
    raw_observation_baseline: { before: null, after: null, unchanged: null },
    capacity_gate: null,
    next_cursor: null,
    stop_reason: null,
    resume: {
      resumed: false,
      cursor: null,
      archives_skipped_before_cursor: [],
      archives_preflighted_this_invocation: []
    }
  };
}

function validateCommonInputs(options, report) {
  const blockers = [];
  if (!options || typeof options !== "object" || Array.isArray(options)) blockers.push("replay_options_object_required");
  if (options.mode !== undefined && !["dry-run", "write"].includes(options.mode)) {
    blockers.push("unsupported_replay_mode");
  }
  if (!isUtcDateTime(options.generatedAt || report.generated_at)) blockers.push("generated_at_must_be_utc");
  if (!Array.isArray(options.archives) || options.archives.length === 0) blockers.push("archive_inventory_required");
  if (!options.r2 || typeof options.r2.getObject !== "function") blockers.push("injected_r2_reader_required");
  if (!options.database || typeof options.database.readRawObservationCount !== "function") {
    blockers.push("read_only_database_baseline_port_required");
  }
  if ((options.mode || "dry-run") === "write" && typeof options.database?.withTransaction !== "function") {
    blockers.push("transactional_database_writer_required");
  }
  return blockers;
}

function validateReviewedInputs(catalogSnapshot, accessModeMapping) {
  const blockers = [];
  if (!catalogSnapshot || catalogSnapshot.status !== "reviewed" ||
      !isNonEmptyString(catalogSnapshot.catalog_version) ||
      !isNonEmptyString(catalogSnapshot.reviewed_by) ||
      !isDateTime(catalogSnapshot.reviewed_at) ||
      !Array.isArray(catalogSnapshot.entries) || catalogSnapshot.entries.length === 0) {
    blockers.push("reviewed_catalog_entry_v1_snapshot_required");
  } else {
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
    if (entriesValid && hasCrossEntryAliasAmbiguity(catalogSnapshot.entries)) {
      blockers.push("reviewed_catalog_snapshot_cross_entry_alias_ambiguity");
    }
  }

  const accessModes = new Map();
  if (!accessModeMapping || accessModeMapping.status !== "reviewed" ||
      !isNonEmptyString(accessModeMapping.catalog_version) ||
      !isNonEmptyString(accessModeMapping.reviewed_by) ||
      !isDateTime(accessModeMapping.reviewed_at) ||
      !Array.isArray(accessModeMapping.mappings) ||
      accessModeMapping.catalog_version !== catalogSnapshot?.catalog_version) {
    blockers.push("reviewed_structured_access_mode_mapping_required");
  } else {
    for (const [index, mapping] of accessModeMapping.mappings.entries()) {
      if (!hasOnlyKeys(mapping, ["park_id", "ride_id", "access_mode"]) ||
          !isNonEmptyString(mapping?.park_id) || !isNonEmptyString(mapping?.ride_id) ||
          !ACCESS_MODES.has(mapping?.access_mode)) {
        blockers.push(`invalid_access_mode_mapping_${index}`);
        continue;
      }
      const key = accessMappingKey(mapping.park_id, mapping.ride_id);
      if (accessModes.has(key)) {
        blockers.push(`duplicate_access_mode_mapping_${index}`);
        continue;
      }
      accessModes.set(key, mapping.access_mode);
    }
  }
  return { blockers, catalogSnapshot, accessModes };
}

/**
 * Fail the whole reviewed scope before preflight when two lifecycle-overlapping
 * entries in one park can resolve the same alias to different canonical IDs;
 * otherwise every affected data row repeats the same ambiguity failure.
 */
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

function validateArchiveDescriptors(descriptors, report) {
  const archives = [];
  const seenIds = new Set();
  const seenUris = new Set();
  let invalidCount = 0;
  for (const [index, descriptor] of descriptors.entries()) {
    try {
      const archive = normalizeArchiveDescriptor(descriptor);
      if (seenIds.has(archive.raw_archive_id) || seenUris.has(archive.r2_uri)) {
        throw replayError("DUPLICATE_ARCHIVE_DESCRIPTOR");
      }
      seenIds.add(archive.raw_archive_id);
      seenUris.add(archive.r2_uri);
      archives.push(archive);
    } catch (error) {
      invalidCount += 1;
      addDiagnostic(report, "archive_failures", {
        archive_index: index,
        source_name: safeSourceName(descriptor?.source_name),
        code: safeErrorCode(error, "INVALID_ARCHIVE_DESCRIPTOR")
      });
    }
  }
  archives.sort((left, right) => left.raw_archive_id.localeCompare(right.raw_archive_id));
  return { archives, invalidCount };
}

function normalizeArchiveDescriptor(descriptor) {
  if (!hasOnlyKeys(descriptor, [...ARCHIVE_DESCRIPTOR_FIELDS]) ||
      Object.keys(descriptor).length !== ARCHIVE_DESCRIPTOR_FIELDS.size ||
      descriptor.contract_version !== "raw-archive.v1" ||
      !SHA256.test(descriptor.raw_archive_id || "") ||
      descriptor.raw_archive_id !== descriptor.sha256 ||
      !SHA256.test(descriptor.sha256 || "") ||
      !Number.isSafeInteger(descriptor.byte_size) || descriptor.byte_size < 1 ||
      !isNonEmptyString(descriptor.source_name) ||
      descriptor.schema_version !== RAW_SCHEMA_VERSION ||
      !isSafeS3Uri(descriptor.object_uri)) {
    throw replayError("INVALID_ARCHIVE_DESCRIPTOR");
  }
  return {
    raw_archive_id: descriptor.raw_archive_id,
    r2_uri: descriptor.object_uri,
    archive_sha256: descriptor.sha256,
    archive_byte_size: descriptor.byte_size,
    source_name: descriptor.source_name,
    archive_schema_version: descriptor.schema_version
  };
}

async function preflightArchives({ archives, r2, catalogSnapshot, accessModes, generatedAt, report }) {
  const archiveRowCounts = new Map();
  for (const archive of archives) {
    try {
      const rows = await readVerifiedArchiveRows(r2, archive);
      report.counts.archives_verified += 1;
      archiveRowCounts.set(archive.raw_archive_id, rows.length);
      for (const [index, row] of rows.entries()) {
        const ordinal = index + 1;
        report.counts.data_rows += 1;
        const outcome = normalizeArchiveRow({
          row,
          archive,
          ordinal,
          catalogSnapshot,
          accessModes,
          generatedAt
        });
        if (!outcome.record) {
          for (const diagnostic of outcome.diagnostics) {
            addDiagnostic(report, diagnostic.kind, diagnostic.sample);
          }
          continue;
        }
        report.counts.normalized_records_planned += 1;
      }
    } catch (error) {
      addDiagnostic(report, "archive_failures", {
        source_name: archive.source_name,
        code: safeErrorCode(error, "ARCHIVE_READ_OR_PARSE_FAILED")
      });
    }
  }
  return { archiveRowCounts };
}

async function readVerifiedArchiveRows(r2, archive) {
  let object;
  try {
    object = await r2.getObject(archive.r2_uri);
  } catch {
    throw replayError("R2_OBJECT_READ_FAILED");
  }
  if (!object || object.r2_uri !== archive.r2_uri || object.immutable !== true ||
      !object.metadata || typeof object.metadata !== "object") {
    throw replayError("R2_OBJECT_METADATA_OR_IMMUTABILITY_MISSING");
  }
  const body = toBuffer(object.body);
  if (!body) throw replayError("R2_OBJECT_BODY_INVALID");
  const actualHash = createHash("sha256").update(body).digest("hex");
  if (actualHash !== archive.archive_sha256 ||
      object.metadata.sha256 !== archive.archive_sha256) {
    throw replayError("ARCHIVE_SHA256_MISMATCH");
  }
  if (body.byteLength !== archive.archive_byte_size ||
      object.contentLength !== archive.archive_byte_size) {
    throw replayError("ARCHIVE_BYTE_SIZE_MISMATCH");
  }
  if (object.metadata.schema_version !== archive.archive_schema_version) {
    throw replayError("ARCHIVE_SCHEMA_METADATA_MISMATCH");
  }
  return parseRawArchiveCsv(body);
}

function normalizeArchiveRow({ row, archive, ordinal, catalogSnapshot, accessModes, generatedAt }) {
  let rawObservation;
  try {
    rawObservation = toRawObservation(row, archive, ordinal);
  } catch (error) {
    return {
      record: null,
      diagnostics: [{
        kind: "normalization_failures",
        sample: { source_name: archive.source_name, source_line_number: ordinal, code: safeErrorCode(error, "RAW_ROW_INVALID") }
      }]
    };
  }

  const accessMode = accessModes.get(accessMappingKey(rawObservation.park_id, rawObservation.ride_id));
  const diagnostics = [];
  if (!accessMode) {
    diagnostics.push({
      kind: "missing_access_modes",
      sample: {
        source_name: archive.source_name,
        source_line_number: ordinal,
        park_id: rawObservation.park_id,
        ride_id: rawObservation.ride_id
      }
    });
  }

  const asOfDate = parkLocalDate(rawObservation.snapshot_utc, rawObservation.snapshot_timezone);
  let resolved;
  try {
    resolved = resolveCanonicalAttraction({
      parkId: rawObservation.park_id,
      sourceAttractionName: rawObservation.ride_name,
      catalogEntries: catalogSnapshot.entries,
      asOfDate
    });
  } catch (error) {
    diagnostics.push({
      kind: "unresolved_identities",
      sample: {
        source_name: archive.source_name,
        source_line_number: ordinal,
        park_id: rawObservation.park_id,
        ride_id: rawObservation.ride_id,
        code: safeErrorCode(error, "CANONICAL_IDENTITY_UNRESOLVED")
      }
    });
  }
  if (!resolved || !accessMode) return { record: null, diagnostics };

  const archiveLineReference = {
    contract_version: ARCHIVE_REFERENCE_VERSION,
    raw_observation_id: rawObservation.raw_observation_id,
    raw_archive_id: archive.raw_archive_id,
    r2_uri: archive.r2_uri,
    archive_sha256: archive.archive_sha256,
    archive_byte_size: archive.archive_byte_size,
    source_line_number: ordinal,
    source_name: archive.source_name,
    archive_schema_version: archive.archive_schema_version
  };

  let normalizedObservation;
  try {
    normalizedObservation = normalizeArchivedWaitObservation({
      rawObservation,
      archiveLineReference,
      catalogEntries: catalogSnapshot.entries,
      accessMode,
      generatedAt,
      transformationVersion: r2ReplayTransformationVersion
    });
  } catch (error) {
    diagnostics.push({
      kind: "normalization_failures",
      sample: {
        source_name: archive.source_name,
        source_line_number: ordinal,
        park_id: rawObservation.park_id,
        ride_id: rawObservation.ride_id,
        code: safeErrorCode(error, "NORMALIZATION_FAILED")
      }
    });
    return { record: null, diagnostics };
  }

  const catalogEntry = catalogSnapshot.entries.find((entry) =>
    entry.park_id === normalizedObservation.park_id &&
    entry.canonical_attraction_id === normalizedObservation.canonical_attraction_id &&
    asOfDate >= entry.lifecycle.valid_from &&
    (entry.lifecycle.valid_to === null || asOfDate < entry.lifecycle.valid_to)
  );
  if (!catalogEntry) {
    return {
      record: null,
      diagnostics: [{
        kind: "normalization_failures",
        sample: {
          source_name: archive.source_name,
          source_line_number: ordinal,
          code: "RESOLVED_CATALOG_SNAPSHOT_NOT_FOUND"
        }
      }]
    };
  }

  return {
    record: { rawObservation, archiveLineReference, normalizedObservation, catalogEntry, archive, ordinal },
    diagnostics
  };
}

function toRawObservation(row, archive, ordinal) {
  const rawObservationId = calculateRawObservationId(archive.archive_sha256, ordinal);
  const raw = {
    contract_version: RAW_SCHEMA_VERSION,
    raw_observation_id: rawObservationId,
    raw_archive_id: archive.raw_archive_id,
    source_row_number: ordinal,
    snapshot_utc: requiredCsvValue(row, "snapshot_utc"),
    snapshot_timezone: requiredCsvValue(row, "snapshot_timezone"),
    park_id: requiredCsvValue(row, "park_id"),
    ride_id: requiredCsvValue(row, "ride_id"),
    ride_name: requiredCsvValue(row, "ride_name"),
    is_open: parseCsvBoolean(requiredCsvValue(row, "is_open")),
    source_last_updated_utc: requiredCsvValue(row, "source_last_updated_utc"),
    source_url: requiredCsvValue(row, "source_url")
  };
  if (!CURRENT_PARK_IDS.has(raw.park_id)) throw replayError("PARK_OUTSIDE_CURRENT_PRODUCT_SCOPE");
  if (row.snapshot_park_datetime) raw.snapshot_park_datetime = row.snapshot_park_datetime;
  if (row.snapshot_park_date) raw.snapshot_park_date = row.snapshot_park_date;
  if (row.park_name) raw.park_name = row.park_name;
  if (row.land) raw.land = row.land;
  if (Object.hasOwn(row, "wait_time_minutes")) raw.wait_time_minutes = parseCsvWait(row.wait_time_minutes);
  if (row.source_last_updated_park_datetime) {
    raw.source_last_updated_park_datetime = row.source_last_updated_park_datetime;
  }
  return raw;
}

async function executeBoundedReplay({
  options,
  archives,
  archiveRowCounts,
  catalogSnapshot,
  accessModes,
  scopeId,
  cursor,
  rowsRemaining,
  report
}) {
  const batchSize = options.batchSize;
  const maxBatches = options.maxBatches;
  let cursorReached = cursor === null;
  let nextCursor = cursor;

  for (const [archiveIndex, archive] of archives.entries()) {
    if (!cursorReached) {
      if (archive.raw_archive_id !== cursor.raw_archive_id) continue;
      cursorReached = true;
    }

    let rows;
    try {
      rows = await readVerifiedArchiveRows(options.r2, archive);
    } catch (error) {
      addDiagnostic(report, "runtime_failures", {
        source_name: archive.source_name,
        code: safeErrorCode(error, "ARCHIVE_REVERIFICATION_FAILED")
      });
      return {
        status: "failed",
        nextCursor: nextCursor ?? {
          scope_id: scopeId,
          raw_archive_id: archive.raw_archive_id,
          next_data_row_ordinal: 1
        },
        stopCode: "archive_reverification_failed"
      };
    }

    const batch = [];
    for (const [index, row] of rows.entries()) {
      const ordinal = index + 1;
      if (cursor?.raw_archive_id === archive.raw_archive_id && ordinal < cursor.next_data_row_ordinal) continue;
      const outcome = normalizeArchiveRow({
        row,
        archive,
        ordinal,
        catalogSnapshot,
        accessModes,
        generatedAt: report.generated_at
      });
      if (!outcome.record) {
        for (const diagnostic of outcome.diagnostics) {
          addDiagnostic(report, "runtime_failures", {
            ...diagnostic.sample,
            code: diagnostic.sample.code || "REPLAY_REVALIDATION_FAILED"
          });
        }
        return {
          status: "failed",
          nextCursor: {
            scope_id: scopeId,
            raw_archive_id: archive.raw_archive_id,
            next_data_row_ordinal: ordinal
          },
          stopCode: "preflight_and_replay_pass_disagreed"
        };
      }
      batch.push(outcome.record);

      if (batch.length === batchSize) {
        const afterBatchCursor = cursorAfterRecord(outcome.record, archiveIndex, archives, archiveRowCounts, scopeId);
        const result = await commitReplayBatch({
          batch,
          batchNumber: report.counts.batches_committed + 1,
          options,
          report,
          scopeId,
          afterBatchCursor
        });
        if (result.status !== "committed") return result;
        batch.length = 0;
        nextCursor = afterBatchCursor;
        const remainingAfter = rowsRemaining - report.counts.normalized_records_committed;
        if (remainingAfter > 0 && report.counts.batches_committed >= maxBatches) {
          return { status: "paused", nextCursor, stopCode: "maximum_batches_per_invocation_reached" };
        }
        if (remainingAfter > 0 && result.usedBytesAfter >= options.capacityGate.stopThresholdBytes) {
          return { status: "paused", nextCursor, stopCode: "capacity_stop_threshold_reached" };
        }
      }
    }

    if (batch.length > 0) {
      const lastRecord = batch.at(-1);
      const afterBatchCursor = cursorAfterRecord(lastRecord, archiveIndex, archives, archiveRowCounts, scopeId);
      const result = await commitReplayBatch({
        batch,
        batchNumber: report.counts.batches_committed + 1,
        options,
        report,
        scopeId,
        afterBatchCursor
      });
      if (result.status !== "committed") return result;
      nextCursor = afterBatchCursor;
      const remainingAfter = rowsRemaining - report.counts.normalized_records_committed;
      if (remainingAfter > 0 && report.counts.batches_committed >= maxBatches) {
        return { status: "paused", nextCursor, stopCode: "maximum_batches_per_invocation_reached" };
      }
      if (remainingAfter > 0 && result.usedBytesAfter >= options.capacityGate.stopThresholdBytes) {
        return { status: "paused", nextCursor, stopCode: "capacity_stop_threshold_reached" };
      }
    }
  }

  if (report.counts.normalized_records_committed < rowsRemaining) {
    return { status: "failed", nextCursor, stopCode: "replay_scope_ended_before_cursor_completion" };
  }
  return { status: "completed", nextCursor: null, stopCode: null };
}

async function commitReplayBatch({ batch, batchNumber, options, report, scopeId, afterBatchCursor }) {
  const estimatedBytes = batch.length * options.capacityGate.estimatedBytesPerRecord;
  let usedBytesBefore;
  try {
    usedBytesBefore = await options.capacityMonitor.readUsedBytes();
  } catch {
    addDiagnostic(report, "runtime_failures", { code: "CAPACITY_MEASUREMENT_FAILED", phase: "before_batch", batch_number: batchNumber });
    return { status: "failed", nextCursor: cursorAtRecord(batch[0], scopeId), stopCode: "capacity_measurement_failed" };
  }
  if (!Number.isSafeInteger(usedBytesBefore) || usedBytesBefore < 0) {
    addDiagnostic(report, "runtime_failures", { code: "CAPACITY_MEASUREMENT_INVALID", phase: "before_batch", batch_number: batchNumber });
    return { status: "failed", nextCursor: cursorAtRecord(batch[0], scopeId), stopCode: "capacity_measurement_invalid" };
  }
  if (usedBytesBefore + estimatedBytes >= options.capacityGate.stopThresholdBytes) {
    return { status: "paused", nextCursor: cursorAtRecord(batch[0], scopeId), stopCode: "capacity_stop_threshold_would_be_reached" };
  }

  try {
    await options.database.withTransaction(async (repositories) => {
      const uniqueCatalogEntries = uniqueBy(batch.map((record) => record.catalogEntry), catalogEntryKey);
      for (const entry of uniqueCatalogEntries) {
        const persisted = await repositories.catalog.putCatalogEntry(entry);
        if (!persisted?.entry || canonicalJson(persisted.entry) !== canonicalJson(entry)) {
          throw replayError("CATALOG_SNAPSHOT_PARITY_MISMATCH");
        }
      }
      for (const record of batch) {
        const persisted = await repositories.archiveLines.putArchiveLineReference(record.archiveLineReference);
        if (!persisted || REFERENCE_FIELDS.some((field) => persisted[field] !== record.archiveLineReference[field])) {
          throw replayError("ARCHIVE_LINE_REFERENCE_PARITY_MISMATCH");
        }
      }
      for (const record of batch) {
        // The 04d3 repository enforces persisted conflict/immutability itself and
        // preserves the first generated_at; replay must not compare an input echo.
        const persisted = await repositories.normalized.putNormalizedObservation(
          record.normalizedObservation
        );
        if (!persisted) throw replayError("NORMALIZED_OBSERVATION_NOT_PERSISTED");
      }
      const healthRecord = createBatchSourceHealthRecord({
        batch,
        scopeId,
        generatedAt: report.generated_at
      });
      await repositories.sourceHealth.upsertSourceHealth(healthRecord);
    });
  } catch (error) {
    addDiagnostic(report, "runtime_failures", {
      code: safeErrorCode(error, "BATCH_TRANSACTION_FAILED"),
      error_name: typeof error?.name === "string" && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name) ? error.name : "Error",
      batch_number: batchNumber
    });
    return { status: "failed", nextCursor: cursorAtRecord(batch[0], scopeId), stopCode: "batch_transaction_failed" };
  }

  report.counts.batches_committed += 1;
  report.counts.normalized_records_committed += batch.length;
  let usedBytesAfter;
  try {
    usedBytesAfter = await options.capacityMonitor.readUsedBytes();
  } catch {
    addDiagnostic(report, "runtime_failures", { code: "CAPACITY_MEASUREMENT_FAILED", phase: "after_batch", batch_number: batchNumber });
    return { status: "failed", nextCursor: afterBatchCursor, stopCode: "capacity_measurement_failed_after_commit" };
  }
  if (!Number.isSafeInteger(usedBytesAfter) || usedBytesAfter < 0) {
    addDiagnostic(report, "runtime_failures", { code: "CAPACITY_MEASUREMENT_INVALID", phase: "after_batch", batch_number: batchNumber });
    return { status: "failed", nextCursor: afterBatchCursor, stopCode: "capacity_measurement_invalid_after_commit" };
  }
  if (usedBytesAfter > options.capacityGate.stopThresholdBytes) {
    addDiagnostic(report, "runtime_failures", { code: "CAPACITY_STOP_THRESHOLD_BREACHED", batch_number: batchNumber });
    return { status: "failed", nextCursor: afterBatchCursor, stopCode: "capacity_stop_threshold_breached" };
  }
  return { status: "committed", usedBytesAfter };
}

function createBatchSourceHealthRecord({ batch, scopeId, generatedAt }) {
  const sourceName = "r2-normalized-history-replay";
  const firstRecord = batch[0];
  const lastRecord = batch.at(-1);
  // Stable by replay scope and first/last archive ordinal: a resumed invocation
  // or an identical retry reuses the same row instead of colliding on a
  // per-invocation batch counter.
  const batchRunId = [
    "r2-normalized-replay",
    scopeId,
    `${firstRecord.archive.raw_archive_id}:${firstRecord.ordinal}`,
    `${lastRecord.archive.raw_archive_id}:${lastRecord.ordinal}`
  ].join(":");
  const payloadManifest = batch.map(({ archiveLineReference }) => archiveLineReference.raw_observation_id).join("\n");
  const payloadSha256 = hashUtf8(payloadManifest);
  const payloadByteSize = Buffer.byteLength(payloadManifest, "utf8");
  const envelope = {
    contract_version: SOURCE_ENVELOPE_VERSION,
    envelope_id: hashUtf8(`${sourceName}:${batchRunId}:${payloadSha256}`),
    source_name: sourceName,
    adapter_version: r2ReplayAdapterVersion,
    schema_version: RAW_SCHEMA_VERSION,
    status: "ok",
    requested_at: generatedAt,
    observed_at: null,
    source_observed_at: null,
    ingested_at: generatedAt,
    source_age_minutes: null,
    payload_sha256: payloadSha256,
    payload_byte_size: payloadByteSize,
    error: null
  };
  return buildSourceHealthRecord({
    envelope,
    runId: batchRunId,
    recordCount: batch.length,
    fallbackStatus: "not_attempted",
    hostedWriteStatus: "written",
    clock: () => new Date(generatedAt)
  });
}

async function validateWriteGate({ options, rowsRemaining, report }) {
  const blockers = getWriteGateBlockers(options, rowsRemaining, report.generated_at);
  if (blockers.length > 0) return { blockers, currentUsedBytes: null };
  let currentUsedBytes;
  try {
    currentUsedBytes = await options.capacityMonitor.readUsedBytes();
  } catch {
    return { blockers: ["capacity_preflight_measurement_failed"], currentUsedBytes: null };
  }
  if (!Number.isSafeInteger(currentUsedBytes) || currentUsedBytes < 0) {
    return { blockers: ["capacity_preflight_measurement_invalid"], currentUsedBytes };
  }
  const gate = options.capacityGate;
  const invocationRowBudget = Math.min(rowsRemaining, options.batchSize * options.maxBatches);
  if (currentUsedBytes + invocationRowBudget * gate.estimatedBytesPerRecord >= gate.stopThresholdBytes) {
    return { blockers: ["bounded_invocation_would_reach_capacity_stop_threshold"], currentUsedBytes };
  }
  return { blockers: [], currentUsedBytes };
}

function getWriteGateBlockers(options, rowsRemaining, generatedAt) {
  const blockers = [];
  if (options.database?.targetLabel !== EXPECTED_TARGET_LABEL) blockers.push("explicit_validation_target_required");
  const authorization = options.authorization;
  if (authorization?.kind !== "validation-only" ||
      !isNonEmptyString(authorization.approvedBy) || !isDateTime(authorization.approvedAt)) {
    blockers.push("explicit_validation_only_authorization_required");
  }
  const batchSize = options.batchSize;
  const maxBatches = options.maxBatches;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > maximumReplayBatchSize ||
      !Number.isSafeInteger(maxBatches) || maxBatches < 1 ||
      maxBatches > maximumReplayBatchesPerInvocation ||
      batchSize * maxBatches > maximumReplayRowsPerInvocation) {
    blockers.push("finite_bounded_batch_limits_required");
  }
  const gate = options.capacityGate;
  if (!gate || gate.approved !== true || gate.targetLabel !== EXPECTED_TARGET_LABEL ||
      !isNonEmptyString(gate.measurementId) || !isDateTime(gate.measuredAt) ||
      !isPositiveSafeInteger(gate.maxCapacityBytes) ||
      !Number.isSafeInteger(gate.reservedHeadroomBytes) || gate.reservedHeadroomBytes < 0 ||
      !isPositiveSafeInteger(gate.stopThresholdBytes) ||
      !isPositiveSafeInteger(gate.estimatedBytesPerRecord) ||
      gate.stopThresholdBytes > gate.maxCapacityBytes - gate.reservedHeadroomBytes) {
    blockers.push("measured_capacity_preflight_required");
  } else {
    const measuredAtMs = Date.parse(gate.measuredAt);
    const generatedAtMs = Date.parse(generatedAt);
    if (!isUtcDateTime(generatedAt) ||
        measuredAtMs > generatedAtMs) {
      blockers.push("capacity_measurement_future_relative_to_generated_at");
    } else if (generatedAtMs - measuredAtMs > maximumCapacityMeasurementAgeMs) {
      blockers.push("capacity_measurement_stale_relative_to_generated_at");
    }
  }
  if (!options.capacityMonitor || typeof options.capacityMonitor.readUsedBytes !== "function") {
    blockers.push("per_batch_capacity_monitor_required");
  }
  if (rowsRemaining < 0) blockers.push("invalid_remaining_row_count");
  return blockers;
}

async function finishRawBaseline(database, report, before) {
  try {
    const after = await readRawObservationCount(database);
    report.raw_observation_baseline.after = after;
    report.raw_observation_baseline.unchanged = before === after;
    if (before !== after) {
      addDiagnostic(report, "runtime_failures", { code: "RAW_OBSERVATION_BASELINE_CHANGED" });
      report.status = "failed";
    }
  } catch {
    addDiagnostic(report, "runtime_failures", { code: "RAW_BASELINE_READ_FAILED", phase: "after" });
    report.status = "failed";
  }
}

async function readRawObservationCount(database) {
  const count = await database.readRawObservationCount();
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError("raw observation baseline must be a non-negative safe integer");
  }
  return count;
}

function parseRawArchiveCsv(buffer) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^\uFEFF/, "");
  } catch {
    throw replayError("ARCHIVE_UTF8_INVALID");
  }
  const records = parseCsvRecords(text);
  if (records.length < 2) throw replayError("ARCHIVE_HAS_NO_DATA_ROWS");
  const headers = records[0];
  if (headers.some((header) => !header) || new Set(headers).size !== headers.length ||
      headers.some((header) => !RAW_CSV_FIELDS.has(header))) {
    throw replayError("ARCHIVE_HEADER_INVALID");
  }
  for (const field of RAW_CSV_REQUIRED_FIELDS) {
    if (!headers.includes(field)) throw replayError("ARCHIVE_REQUIRED_COLUMN_MISSING");
  }
  const rows = [];
  for (const record of records.slice(1)) {
    if (record.length === 1 && record[0] === "") continue;
    if (record.length !== headers.length) throw replayError("ARCHIVE_ROW_WIDTH_MISMATCH");
    rows.push(Object.fromEntries(headers.map((header, index) => [header, record[index]])));
  }
  if (rows.length === 0) throw replayError("ARCHIVE_HAS_NO_DATA_ROWS");
  return rows;
}

function parseCsvRecords(text) {
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;

  const finishField = () => {
    record.push(field);
    field = "";
    closedQuote = false;
  };
  const finishRecord = () => {
    finishField();
    if (!(record.length === 1 && record[0] === "")) records.push(record);
    record = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
        closedQuote = true;
      } else {
        field += character;
      }
      continue;
    }

    if (closedQuote && character !== "," && character !== "\r" && character !== "\n") {
      throw replayError("ARCHIVE_CSV_INVALID");
    }
    if (character === '"') {
      if (field !== "" || closedQuote) throw replayError("ARCHIVE_CSV_INVALID");
      quoted = true;
    } else if (character === ",") {
      finishField();
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      finishRecord();
    } else {
      field += character;
    }
  }
  if (quoted) throw replayError("ARCHIVE_CSV_UNTERMINATED_QUOTE");
  if (field !== "" || record.length > 0 || closedQuote) finishRecord();
  return records;
}

function parseCsvBoolean(value) {
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  throw replayError("RAW_ROW_BOOLEAN_INVALID");
}

function parseCsvWait(value) {
  if (value === "") return null;
  if (!/^\d+$/.test(value)) throw replayError("RAW_ROW_WAIT_INVALID");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw replayError("RAW_ROW_WAIT_INVALID");
  return parsed;
}

function requiredCsvValue(row, field) {
  const value = row[field];
  if (typeof value !== "string" || value.trim() === "") throw replayError("RAW_ROW_REQUIRED_FIELD_MISSING");
  return value;
}

function parkLocalDate(timestamp, timezone) {
  const instant = new Date(timestamp);
  if (Number.isNaN(instant.getTime())) throw replayError("RAW_ROW_TIMESTAMP_INVALID");
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(instant);
  } catch {
    throw replayError("RAW_ROW_TIMEZONE_INVALID");
  }
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function validateResumeCursorIdentity(cursor, scopeId, archives) {
  if (cursor === null || cursor === undefined) return { value: null, error: null };
  if (!hasOnlyKeys(cursor, ["scope_id", "raw_archive_id", "next_data_row_ordinal"])) {
    return { value: null, error: "resume_cursor_invalid" };
  }
  if (cursor.scope_id !== scopeId) return { value: null, error: "resume_cursor_scope_mismatch" };
  if (!SHA256.test(cursor.raw_archive_id || "") ||
      !Number.isSafeInteger(cursor.next_data_row_ordinal) || cursor.next_data_row_ordinal < 1) {
    return { value: null, error: "resume_cursor_invalid" };
  }
  const archive = archives.find(({ raw_archive_id }) => raw_archive_id === cursor.raw_archive_id);
  if (!archive) return { value: null, error: "resume_cursor_archive_not_in_scope" };
  return {
    value: {
      scope_id: cursor.scope_id,
      raw_archive_id: cursor.raw_archive_id,
      next_data_row_ordinal: cursor.next_data_row_ordinal
    },
    error: null
  };
}

function validateResumeCursorRange(cursor, archiveRowCounts) {
  if (cursor === null) return { value: null, error: null };
  const rowCount = archiveRowCounts.get(cursor.raw_archive_id);
  if (!Number.isSafeInteger(rowCount)) return { value: null, error: "resume_cursor_archive_not_preflighted" };
  if (cursor.next_data_row_ordinal > rowCount + 1) {
    return { value: null, error: "resume_cursor_ordinal_out_of_range" };
  }
  return { value: { ...cursor }, error: null };
}

function countRowsFromCursor(archives, archiveRowCounts, cursor) {
  if (!cursor) return [...archiveRowCounts.values()].reduce((total, count) => total + count, 0);
  const startIndex = archives.findIndex(({ raw_archive_id }) => raw_archive_id === cursor.raw_archive_id);
  if (startIndex < 0) return 0;
  let count = Math.max(0, archiveRowCounts.get(cursor.raw_archive_id) - cursor.next_data_row_ordinal + 1);
  for (const archive of archives.slice(startIndex + 1)) count += archiveRowCounts.get(archive.raw_archive_id) || 0;
  return count;
}

function cursorAtRecord(record, scopeId) {
  return { scope_id: scopeId, raw_archive_id: record.archive.raw_archive_id, next_data_row_ordinal: record.ordinal };
}

function cursorAfterRecord(record, archiveIndex, archives, archiveRowCounts, scopeId) {
  const rowCount = archiveRowCounts.get(record.archive.raw_archive_id);
  if (record.ordinal < rowCount) {
    return { scope_id: scopeId, raw_archive_id: record.archive.raw_archive_id, next_data_row_ordinal: record.ordinal + 1 };
  }
  const nextArchive = archives[archiveIndex + 1];
  return nextArchive ? { scope_id: scopeId, raw_archive_id: nextArchive.raw_archive_id, next_data_row_ordinal: 1 } : null;
}

function addDiagnostic(report, kind, sample) {
  const diagnostic = report.diagnostics[kind];
  diagnostic.count += 1;
  if (diagnostic.samples.length < MAX_DIAGNOSTIC_SAMPLES) diagnostic.samples.push(sample);
  const countKey = kind;
  if (Object.hasOwn(report.counts, countKey)) report.counts[countKey] += 1;
}

function hasPreflightIssues(report) {
  return Object.values(report.diagnostics).some(({ count }) => count > 0);
}

function addBlocker(report, blocker) {
  if (!report.blockers.includes(blocker)) report.blockers.push(blocker);
}

function accessMappingKey(parkId, rideId) {
  return `${parkId}\u001f${rideId}`;
}

function catalogEntryKey(entry) {
  return [entry.park_id, entry.canonical_attraction_id, entry.lifecycle.catalog_version, entry.lifecycle.valid_from].join("\u001f");
}

function uniqueBy(values, keyOf) {
  return [...new Map(values.map((value) => [keyOf(value), value])).values()];
}

function hashUtf8(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function isSafeS3Uri(value) {
  if (typeof value !== "string") return false;
  try {
    const uri = new URL(value);
    return uri.protocol === "s3:" && Boolean(uri.hostname) && Boolean(uri.pathname.slice(1)) &&
      !uri.username && !uri.password && !uri.search && !uri.hash;
  } catch {
    return false;
  }
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
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

function safeSourceName(value) {
  return typeof value === "string" && value.length <= 200 ? value : null;
}

function safeErrorCode(error, fallback) {
  return typeof error?.code === "string" && /^[A-Z0-9_:-]{1,80}$/.test(error.code)
    ? error.code
    : fallback;
}

function replayError(code) {
  return Object.assign(new Error(code), { code });
}

function calculateReplayScopeId({ archives, catalogSnapshot, accessModes }) {
  const mapping = [...accessModes.entries()]
    .map(([key, access_mode]) => ({ key, access_mode }))
    .sort((left, right) => left.key.localeCompare(right.key));
  const archiveScope = archives.map((archive) => ({
    raw_archive_id: archive.raw_archive_id,
    r2_uri: archive.r2_uri,
    archive_sha256: archive.archive_sha256,
    archive_byte_size: archive.archive_byte_size,
    source_name: archive.source_name,
    archive_schema_version: archive.archive_schema_version
  }));
  return hashUtf8(canonicalJson({
    archive_scope: archiveScope,
    catalog_version: catalogSnapshot.catalog_version,
    catalog_entries: catalogSnapshot.entries,
    access_modes: mapping,
    transformation_version: r2ReplayTransformationVersion
  }));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function snapshotReplayOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("replay options must be an object");
  }
  const snapshot = { ...options };
  for (const field of [
    "archives",
    "catalogSnapshot",
    "accessModeMapping",
    "authorization",
    "capacityGate",
    "resumeFrom"
  ]) {
    if (Object.hasOwn(options, field)) snapshot[field] = structuredClone(options[field]);
  }
  return snapshot;
}

function hasOnlyKeys(value, allowedKeys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)) &&
    Object.keys(value).every((key) => allowedKeys.includes(key));
}

function isCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
