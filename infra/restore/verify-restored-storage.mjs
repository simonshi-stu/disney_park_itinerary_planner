import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverMigrations } from "../migrations/run-migrations.mjs";

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../migrations"
);

const REQUIRED_RELATIONS = [
  "catalog.parks",
  "catalog.attractions",
  "catalog.attraction_aliases",
  "catalog.lifecycle_records",
  "catalog.lifecycle_evidence",
  "ingestion.raw_archives",
  "ingestion.raw_wait_observations",
  "observations.normalized_wait_observations",
  "infrastructure.schema_migrations",
];

const REQUIRED_RAW_TRIGGERS = [
  { table: "ingestion.raw_archives", trigger: "raw_archives_are_immutable" },
  {
    table: "ingestion.raw_wait_observations",
    trigger: "raw_wait_observations_are_immutable",
  },
];

/**
 * Normalize a PostgreSQL URL into a comparable target.
 * Lowercases hostname, defaults port to 5432, decodes database path.
 * Ignores username, password, and query parameters.
 *
 * @param {string} url - PostgreSQL connection URL
 * @returns {{host: string, port: number, database: string}}
 */
export function normalizeDatabaseTarget(url) {
  if (typeof url !== "string" || url.length === 0) {
    throw new TypeError("database URL must be a non-empty string");
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new TypeError(`unsupported database URL protocol: ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port ? Number(parsed.port) : 5432;
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  return { host, port, database };
}

/**
 * Assert that the restore target is not the same as the production DATABASE_URL.
 * Throws if RESTORE_DATABASE_URL is missing or if both URLs identify the same
 * host/port/database. Comparison ignores username, password, and query params.
 *
 * @param {string|undefined} databaseUrl - production DATABASE_URL
 * @param {string|undefined} restoreDatabaseUrl - RESTORE_DATABASE_URL
 */
export function assertSafeRestoreTarget(databaseUrl, restoreDatabaseUrl) {
  if (!restoreDatabaseUrl) {
    throw new Error("RESTORE_DATABASE_URL is required");
  }
  if (!databaseUrl) {
    return; // No production URL configured; cannot compare targets
  }
  const prod = normalizeDatabaseTarget(databaseUrl);
  const restore = normalizeDatabaseTarget(restoreDatabaseUrl);
  if (
    prod.host === restore.host &&
    prod.port === restore.port &&
    prod.database === restore.database
  ) {
    throw new Error(
      `restore target ${restore.host}:${restore.port}/${restore.database} is the same as DATABASE_URL`
    );
  }
}

export async function verifyRestoredStorage(client) {
  const runId = randomUUID();
  const checkedAt = new Date().toISOString();
  const checks = [];
  const failures = [];

  const addCheck = (name, passed, detail = null) => {
    checks.push({ name, passed, detail });
    if (!passed) {
      failures.push({ name, detail });
    }
  };

  await client.query("BEGIN TRANSACTION READ ONLY");

  try {
    // 1. Required relations exist (checked before any dependent query)
    const missingRelations = [];
    const availableRelations = new Set();
    for (const relation of REQUIRED_RELATIONS) {
      const result = await client.query("SELECT to_regclass($1) AS regclass", [
        relation,
      ]);
      if (!result.rows[0].regclass) {
        missingRelations.push(relation);
      } else {
        availableRelations.add(relation);
      }
    }
    addCheck("required_relations", missingRelations.length === 0, {
      missing: missingRelations,
    });

    // 2. Migration ledger: all discovered migration files present with matching checksums
    const migrations = await discoverMigrations(MIGRATIONS_DIR);
    const migrationFiles = migrations.map((m) => m.filename);
    const migrationChecksums = Object.fromEntries(
      migrations.map((m) => [m.filename, m.checksum])
    );
    if (availableRelations.has("infrastructure.schema_migrations")) {
      const ledgerResult = await client.query(
        `SELECT filename, checksum FROM infrastructure.schema_migrations ORDER BY filename`
      );
      const ledger = new Map(
        ledgerResult.rows.map((r) => [r.filename, r.checksum])
      );
      const ledgerMissing = migrationFiles.filter((f) => !ledger.has(f));
      const ledgerMismatch = migrationFiles.filter(
        (f) => ledger.has(f) && ledger.get(f) !== migrationChecksums[f]
      );
      addCheck(
        "migration_ledger",
        ledgerMissing.length === 0 && ledgerMismatch.length === 0,
        {
          missing: ledgerMissing,
          checksum_mismatch: ledgerMismatch,
          expected: migrationChecksums,
          found: Object.fromEntries(ledger),
        }
      );
    } else {
      addCheck("migration_ledger", false, {
        skipped_due_to_missing_relations: ["infrastructure.schema_migrations"],
      });
    }

    // 3. Raw immutability triggers exist (only if raw tables are available)
    const missingTriggers = [];
    for (const { table, trigger } of REQUIRED_RAW_TRIGGERS) {
      if (!availableRelations.has(table)) {
        missingTriggers.push({ table, trigger });
        continue;
      }
      const result = await client.query(
        `SELECT 1
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname || '.' || c.relname = $1
           AND t.tgname = $2
           AND NOT t.tgisinternal`,
        [table, trigger]
      );
      if (result.rowCount === 0) {
        missingTriggers.push({ table, trigger });
      }
    }
    addCheck("raw_immutability_triggers", missingTriggers.length === 0, {
      missing: missingTriggers,
    });

    // 4. Lineage orphans: normalized rows referencing missing raw rows
    if (
      availableRelations.has("observations.normalized_wait_observations") &&
      availableRelations.has("ingestion.raw_wait_observations")
    ) {
      const orphanResult = await client.query(`
        SELECT count(*)::int AS orphan_count
        FROM observations.normalized_wait_observations AS n
        LEFT JOIN ingestion.raw_wait_observations AS r
          ON r.raw_observation_id = n.raw_observation_id
        WHERE r.raw_observation_id IS NULL
      `);
      const orphanCount = orphanResult.rows[0].orphan_count;
      addCheck("lineage_orphans", orphanCount === 0, {
        orphan_count: orphanCount,
      });
    } else {
      addCheck("lineage_orphans", false, {
        reason: "required relations missing",
      });
    }

    // 5. Closed-wait semantics: closed rows must have NULL observed wait
    if (availableRelations.has("observations.normalized_wait_observations")) {
      const closedWaitResult = await client.query(`
        SELECT count(*)::int AS violation_count
        FROM observations.normalized_wait_observations
        WHERE NOT is_open AND observed_wait_time_minutes IS NOT NULL
      `);
      const closedWaitViolations = closedWaitResult.rows[0].violation_count;
      addCheck("closed_wait_semantics", closedWaitViolations === 0, {
        violation_count: closedWaitViolations,
      });
    } else {
      addCheck("closed_wait_semantics", false, {
        reason: "required relations missing",
      });
    }

    // 6. Raw archive/observation counts (must be positive)
    if (
      availableRelations.has("ingestion.raw_archives") &&
      availableRelations.has("ingestion.raw_wait_observations")
    ) {
      const rawCountsResult = await client.query(`
        SELECT
          (SELECT count(*)::int FROM ingestion.raw_archives) AS archive_count,
          (SELECT count(*)::int FROM ingestion.raw_wait_observations) AS observation_count
      `);
      const rawCounts = rawCountsResult.rows[0];
      addCheck(
        "raw_counts",
        rawCounts.archive_count > 0 && rawCounts.observation_count > 0,
        rawCounts
      );
    } else {
      addCheck("raw_counts", false, {
        reason: "required relations missing",
      });
    }

    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback errors; primary error is more important
    }
    throw err;
  }

  const status = failures.length === 0 ? "ok" : "failed";
  return {
    run_id: runId,
    checked_at: checkedAt,
    status,
    checks,
    failures,
  };
}

/**
 * Thin CLI entrypoint. Requires RESTORE_DATABASE_URL.
 */
async function main() {
  const { default: pg } = await import("pg");
  const databaseUrl = process.env.DATABASE_URL;
  const restoreDatabaseUrl = process.env.RESTORE_DATABASE_URL;

  try {
    assertSafeRestoreTarget(databaseUrl, restoreDatabaseUrl);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  const pool = new pg.Pool({ connectionString: restoreDatabaseUrl });
  try {
    const client = await pool.connect();
    try {
    const result = await verifyRestoredStorage(client);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "ok") {
      process.exitCode = 1;
    }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

// Only run main when executed directly (not when imported by tests)
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
