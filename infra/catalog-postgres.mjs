import { createHash } from "node:crypto";
import { resolveCanonicalAttraction } from "../modules/catalog/index.mjs";
import { assertCallerTransactionClient } from "./normalized-observations-postgres.mjs";

export class CatalogEntryConflictError extends Error {
  constructor(parkId, canonicalAttractionId, catalogVersion) {
    super(`Catalog entry ${parkId}/${canonicalAttractionId} conflicts within catalog version ${catalogVersion}.`);
    this.name = "CatalogEntryConflictError";
    this.code = "CATALOG_ENTRY_CONFLICT";
  }
}

/** Persistence port for immutable catalog-entry.v1 snapshots; client is caller transaction-bound. */
export function createPostgresCatalogRepository(client) {
  const transactionToken = assertCallerTransactionClient(client);

  return {
    async putCatalogEntry(entry) {
      assertCallerTransactionClient(client, transactionToken);
      validateCatalogEntry(entry);
      const lifecycle = entry.lifecycle;
      const catalogEntryId = createHash("sha256").update(canonicalJson(entry), "utf8").digest("hex");
      const key = [entry.park_id, entry.canonical_attraction_id, lifecycle.catalog_version, lifecycle.valid_from].join(":");

      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`catalog-entry:${key}`]
      );
      const existing = await client.query(
        `SELECT catalog_entry_id, entry_document
           FROM catalog.catalog_entry_snapshots
          WHERE park_id = $1
            AND canonical_attraction_id = $2
            AND catalog_version = $3
            AND valid_from = $4::date
          FOR UPDATE`,
        [entry.park_id, entry.canonical_attraction_id, lifecycle.catalog_version, lifecycle.valid_from]
      );

      if (existing.rows.length > 0) {
        const persistedEntry = parseEntryDocument(existing.rows[0].entry_document);
        if (existing.rows[0].catalog_entry_id.trim() !== catalogEntryId ||
            canonicalJson(persistedEntry) !== canonicalJson(entry)) {
          throw new CatalogEntryConflictError(entry.park_id, entry.canonical_attraction_id, lifecycle.catalog_version);
        }
        return { catalog_entry_id: catalogEntryId, entry: persistedEntry, inserted: false };
      }

      const inserted = await client.query(
        `INSERT INTO catalog.catalog_entry_snapshots (
           catalog_entry_id, contract_version, operator_id, resort_id, park_id,
           canonical_attraction_id, catalog_version, valid_from, valid_to, generated_at, entry_document
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9::date, $10::timestamptz, $11::jsonb)
         RETURNING catalog_entry_id`,
        [
          catalogEntryId,
          entry.contract_version,
          entry.operator_id,
          entry.resort_id,
          entry.park_id,
          entry.canonical_attraction_id,
          lifecycle.catalog_version,
          lifecycle.valid_from,
          lifecycle.valid_to,
          lifecycle.generated_at,
          JSON.stringify(entry)
        ]
      );
      if (inserted.rows.length !== 1) throw new Error("Catalog entry insert did not return its key.");
      return { catalog_entry_id: catalogEntryId, entry, inserted: true };
    },

    async listCatalogEntries({ parkId, catalogVersion, asOfDate } = {}) {
      assertCallerTransactionClient(client, transactionToken);
      if (!isNonEmptyString(parkId) || !isNonEmptyString(catalogVersion) || !isCalendarDate(asOfDate)) {
        throw new TypeError("parkId, catalogVersion, and a valid park-local asOfDate are required.");
      }
      const result = await client.query(
        `SELECT entry_document
           FROM catalog.catalog_entry_snapshots
          WHERE park_id = $1
            AND catalog_version = $2
            AND valid_from <= $3::date
            AND (valid_to IS NULL OR $3::date < valid_to)
          ORDER BY canonical_attraction_id`,
        [parkId, catalogVersion, asOfDate]
      );
      return result.rows.map((row) => parseEntryDocument(row.entry_document));
    }
  };
}

function validateCatalogEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
      typeof entry.park_id !== "string" || !Array.isArray(entry.aliases) || entry.aliases.length === 0 ||
      typeof entry.lifecycle?.valid_from !== "string") {
    throw new TypeError("catalog-entry.v1 with a lifecycle effective date is required.");
  }
  // The public resolver is the catalog module's authoritative v1 validator.
  resolveCanonicalAttraction({
    parkId: entry.park_id,
    sourceAttractionName: entry.aliases[0],
    catalogEntries: [entry],
    asOfDate: entry.lifecycle.valid_from
  });
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function parseEntryDocument(value) {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function isCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
