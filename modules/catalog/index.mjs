const ACCESS_MODES = new Set(["standby", "single_rider", "virtual_queue", "other"]);
const CATEGORIES = new Set(["attraction", "entertainment"]);
const OPERATIONAL_STATES = new Set(["operating", "refurbishment", "seasonal", "retired", "unknown"]);
const WAIT_CAPABILITIES = new Set(["posted_standby", "schedule_only", "no_queue", "unknown"]);
const TRAINING_DISPOSITIONS = new Set(["eligible", "ineligible_no_wait", "ineligible_lifecycle", "review_required"]);
const PLANNING_DISPOSITIONS = new Set(["eligible", "schedule_constraint", "ineligible_lifecycle", "review_required"]);
const OFFICIAL_EVIDENCE_TYPES = new Set(["official_disney_page", "official_disney_app"]);
const EVIDENCE_TYPES = new Set([...OFFICIAL_EVIDENCE_TYPES, "manual_review"]);
const CATALOG_ENTRY_FIELDS = new Set([
  "contract_version",
  "operator_id",
  "resort_id",
  "park_id",
  "aliases",
  "canonical_attraction_id",
  "canonical_attraction_name",
  "canonical_category",
  "lifecycle"
]);
const LIFECYCLE_FIELDS = new Set([
  "contract_version",
  "canonical_attraction_id",
  "park_id",
  "park_timezone",
  "wait_capability",
  "supported_access_modes",
  "operational_state",
  "training_disposition",
  "planning_disposition",
  "evidence",
  "valid_from",
  "valid_to",
  "catalog_version",
  "generated_at"
]);
const EVIDENCE_FIELDS = new Set(["source_type", "source_url", "verified_at", "reviewed_by", "notes"]);

export class CanonicalAttractionResolutionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CanonicalAttractionResolutionError";
    this.code = code;
  }
}

/**
 * Resolve a source name against an injected, park-scoped catalog snapshot.
 * Lifecycle dates use the half-open interval [valid_from, valid_to).
 */
export function resolveCanonicalAttraction({ parkId, sourceAttractionName, catalogEntries, asOfDate } = {}) {
  if (!isNonEmptyString(parkId)) throw new TypeError("parkId is required");
  if (!isNonEmptyString(sourceAttractionName)) throw new TypeError("sourceAttractionName is required");
  if (!Array.isArray(catalogEntries)) throw new TypeError("catalogEntries must be an array");
  if (!isCalendarDate(asOfDate)) throw new TypeError("asOfDate must be a valid YYYY-MM-DD date");

  const entries = catalogEntries.map(validateCatalogEntry);
  const exactAlias = normalizeAlias(sourceAttractionName);
  const baseAlias = normalizeAlias(stripSingleRiderSuffix(sourceAttractionName));
  let candidates = entries.filter((entry) =>
    entry.park_id === parkId && entry.aliases.some((alias) => normalizeAlias(alias) === exactAlias)
  );
  let canonicalMatchSource = "alias_exact";

  if (candidates.length === 0 && baseAlias !== exactAlias) {
    candidates = entries.filter((entry) =>
      entry.park_id === parkId && entry.aliases.some((alias) => normalizeAlias(alias) === baseAlias)
    );
    canonicalMatchSource = "alias_base";
  }

  if (candidates.length === 0) {
    throw new CanonicalAttractionResolutionError(
      "UNKNOWN_CANONICAL_ATTRACTION",
      `No catalog alias for park ${parkId} matches the supplied attraction name`
    );
  }

  const activeCandidates = candidates.filter(({ lifecycle }) =>
    asOfDate >= lifecycle.valid_from && (lifecycle.valid_to === null || asOfDate < lifecycle.valid_to)
  );
  if (activeCandidates.length === 0) {
    throw new CanonicalAttractionResolutionError(
      "CATALOG_LIFECYCLE_NOT_EFFECTIVE",
      `The matching catalog lifecycle is not effective on ${asOfDate}`
    );
  }

  const canonicalIds = new Set(activeCandidates.map((entry) => entry.canonical_attraction_id));
  if (canonicalIds.size !== 1 || hasConflictingActiveEntries(activeCandidates)) {
    throw new CanonicalAttractionResolutionError(
      "AMBIGUOUS_CANONICAL_ATTRACTION",
      `More than one active canonical identity matches the supplied attraction name in park ${parkId}`
    );
  }

  const entry = activeCandidates[0];
  const lifecycle = entry.lifecycle;
  return {
    operator_id: entry.operator_id,
    resort_id: entry.resort_id,
    park_id: entry.park_id,
    park_timezone: lifecycle.park_timezone,
    canonical_attraction_id: entry.canonical_attraction_id,
    canonical_attraction_name: entry.canonical_attraction_name,
    canonical_category: entry.canonical_category,
    canonical_match_source: canonicalMatchSource,
    wait_capability: lifecycle.wait_capability,
    supported_access_modes: [...lifecycle.supported_access_modes],
    operational_state: lifecycle.operational_state,
    training_disposition: lifecycle.training_disposition,
    planning_disposition: lifecycle.planning_disposition
  };
}

function validateCatalogEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) invalidCatalog("entry must be an object");
  const unexpectedFields = Object.keys(entry).filter((field) => !CATALOG_ENTRY_FIELDS.has(field));
  if (unexpectedFields.length > 0) {
    invalidCatalog(`catalog-entry.v1 does not allow ${unexpectedFields.join(", ")}`);
  }
  if (entry.contract_version !== "catalog-entry.v1") invalidCatalog("unsupported catalog entry contract_version");
  for (const field of ["operator_id", "resort_id", "park_id", "canonical_attraction_id", "canonical_attraction_name"]) {
    if (!isNonEmptyString(entry[field])) invalidCatalog(`${field} must be a non-empty string`);
  }
  if (!CATEGORIES.has(entry.canonical_category)) invalidCatalog("canonical_category is unsupported");
  if (!Array.isArray(entry.aliases) || entry.aliases.length === 0 || entry.aliases.some((alias) => !isNonEmptyString(alias))) {
    invalidCatalog("aliases must contain at least one non-empty source name");
  }

  const lifecycle = entry.lifecycle;
  if (!lifecycle || typeof lifecycle !== "object" || Array.isArray(lifecycle)) invalidCatalog("lifecycle is required");
  const unexpectedLifecycleFields = Object.keys(lifecycle).filter((field) => !LIFECYCLE_FIELDS.has(field));
  if (unexpectedLifecycleFields.length > 0) {
    invalidCatalog(`catalog-attraction-lifecycle.v1 does not allow ${unexpectedLifecycleFields.join(", ")}`);
  }
  if (lifecycle.contract_version !== "catalog-attraction-lifecycle.v1") invalidCatalog("unsupported lifecycle contract_version");
  if (lifecycle.canonical_attraction_id !== entry.canonical_attraction_id || lifecycle.park_id !== entry.park_id) {
    invalidCatalog("lifecycle identity must match its catalog entry");
  }
  if (lifecycle.park_timezone !== "America/Los_Angeles" || !isIanaTimezone(lifecycle.park_timezone)) {
    invalidCatalog("lifecycle park_timezone must be a valid current-scope park timezone");
  }
  if (!WAIT_CAPABILITIES.has(lifecycle.wait_capability)) invalidCatalog("wait_capability is unsupported");
  if (!Array.isArray(lifecycle.supported_access_modes) ||
      lifecycle.supported_access_modes.some((mode) => !ACCESS_MODES.has(mode)) ||
      new Set(lifecycle.supported_access_modes).size !== lifecycle.supported_access_modes.length) {
    invalidCatalog("supported_access_modes must contain unique supported modes");
  }
  if (!OPERATIONAL_STATES.has(lifecycle.operational_state)) invalidCatalog("operational_state is unsupported");
  if (!TRAINING_DISPOSITIONS.has(lifecycle.training_disposition)) invalidCatalog("training_disposition is unsupported");
  if (!PLANNING_DISPOSITIONS.has(lifecycle.planning_disposition)) invalidCatalog("planning_disposition is unsupported");
  if (!Array.isArray(lifecycle.evidence) || lifecycle.evidence.length === 0) invalidCatalog("lifecycle evidence is required");
  for (const evidence of lifecycle.evidence) validateEvidence(evidence);

  if (["refurbishment", "retired"].includes(lifecycle.operational_state) &&
      (lifecycle.training_disposition !== "ineligible_lifecycle" || lifecycle.planning_disposition !== "ineligible_lifecycle")) {
    invalidCatalog("refurbishment and retired entries must be excluded from training and planning");
  }
  if (lifecycle.operational_state === "unknown" &&
      (lifecycle.training_disposition !== "review_required" || lifecycle.planning_disposition !== "review_required")) {
    invalidCatalog("unknown lifecycle entries must require training and planning review");
  }
  if (["operating", "refurbishment", "seasonal", "retired"].includes(lifecycle.operational_state) &&
      !lifecycle.evidence.some(({ source_type }) => OFFICIAL_EVIDENCE_TYPES.has(source_type))) {
    invalidCatalog("known lifecycle states require official Disney page or app evidence");
  }

  if (!isCalendarDate(lifecycle.valid_from) ||
      !(lifecycle.valid_to === null || isCalendarDate(lifecycle.valid_to)) ||
      (lifecycle.valid_to !== null && lifecycle.valid_to <= lifecycle.valid_from)) {
    invalidCatalog("lifecycle valid_from/valid_to dates are invalid");
  }
  if (!isNonEmptyString(lifecycle.catalog_version) || !isValidDateTime(lifecycle.generated_at)) {
    invalidCatalog("lifecycle catalog_version and generated_at are required");
  }
  return entry;
}

function validateEvidence(evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) || !EVIDENCE_TYPES.has(evidence.source_type)) {
    invalidCatalog("lifecycle evidence has an unsupported source_type");
  }
  const unexpectedEvidenceFields = Object.keys(evidence).filter((field) => !EVIDENCE_FIELDS.has(field));
  if (unexpectedEvidenceFields.length > 0) {
    invalidCatalog(`catalog lifecycle evidence does not allow ${unexpectedEvidenceFields.join(", ")}`);
  }
  if (!(evidence.source_url === null || isValidUri(evidence.source_url)) ||
      (evidence.source_type === "official_disney_page" && !isValidHttpsUri(evidence.source_url)) ||
      !isValidDateTime(evidence.verified_at) || !isNonEmptyString(evidence.reviewed_by) ||
      (Object.hasOwn(evidence, "notes") && typeof evidence.notes !== "string")) {
    invalidCatalog("lifecycle evidence is incomplete");
  }
}

function hasConflictingActiveEntries(entries) {
  const signatures = new Set(entries.map((entry) => JSON.stringify([
    entry.operator_id,
    entry.resort_id,
    entry.canonical_attraction_name,
    entry.canonical_category,
    entry.lifecycle.park_timezone,
    entry.lifecycle.wait_capability,
    [...entry.lifecycle.supported_access_modes].sort(),
    entry.lifecycle.operational_state,
    entry.lifecycle.training_disposition,
    entry.lifecycle.planning_disposition,
    entry.lifecycle.valid_from,
    entry.lifecycle.valid_to,
    entry.lifecycle.catalog_version
  ])));
  return signatures.size > 1;
}

function normalizeAlias(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[™®©]/g, "")
    .replace(/[’‘`]/g, "'")
    .replace(/[“”"]/g, "")
    .replace(/[–—]/g, "-")
    .replace(/\s*&\s*/g, " and ")
    .replace(/[^a-z0-9'\- ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripSingleRiderSuffix(value) {
  return String(value || "").replace(/\s+single\s+rider\s*$/i, "").trim();
}

function isCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isValidDateTime(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match || !isCalendarDate(match[1])) return false;
  if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return false;
  if (match[6] && (Number(match[6]) > 23 || Number(match[7]) > 59)) return false;
  return !Number.isNaN(Date.parse(value));
}

function isValidUri(value) {
  if (!isNonEmptyString(value)) return false;
  try {
    return Boolean(new URL(value).protocol);
  } catch {
    return false;
  }
}

function isValidHttpsUri(value) {
  if (!isValidUri(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isIanaTimezone(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function invalidCatalog(reason) {
  throw new CanonicalAttractionResolutionError("INVALID_CATALOG_ENTRY", reason);
}
