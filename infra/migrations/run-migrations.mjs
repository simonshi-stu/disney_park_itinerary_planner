import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const LEDGER_TABLE = "infrastructure.schema_migrations";
const ADVISORY_LOCK_KEY = 727001; // arbitrary project-specific key

/**
 * Compute SHA-256 hex digest of a string.
 */
export function sha256Hex(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Discover migration files in a directory.
 * Lexical order, additive, repeatable. Only .sql files matching ^\d+_.*\.sql$ are considered.
 */
export async function discoverMigrations(dir = MIGRATIONS_DIR) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && /^\d+_.*\.sql$/.test(e.name))
    .map((e) => e.name)
    .sort();
  const migrations = [];
  for (const name of files) {
    const fullPath = path.join(dir, name);
    const content = await readFile(fullPath, "utf8");
    migrations.push({ filename: name, path: fullPath, content, checksum: sha256Hex(content) });
  }
  return migrations;
}

/**
 * Bootstrap the ledger table if it does not exist.
 * Uses IF NOT EXISTS so it is idempotent and additive.
 */
export async function bootstrapLedger(client) {
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS infrastructure;
    CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
      filename text PRIMARY KEY,
      checksum char(64) NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

/**
 * Acquire a PostgreSQL advisory lock on a dedicated client.
 * Uses blocking pg_advisory_lock so concurrent runners serialize.
 * Returns true when the lock is acquired (query completes successfully).
 */
export async function acquireAdvisoryLock(client) {
  await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
  return true;
}

/**
 * Release the advisory lock. Best-effort; errors are swallowed to avoid masking primary errors.
 */
export async function releaseAdvisoryLock(client) {
  await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
}

/**
 * Load applied migrations from the ledger.
 * Returns a Map of filename -> { checksum, applied_at }.
 */
export async function loadAppliedMigrations(client) {
  const result = await client.query(`SELECT filename, checksum, applied_at FROM ${LEDGER_TABLE}`);
  return new Map(result.rows.map((r) => [r.filename, { checksum: r.checksum, applied_at: r.applied_at }]));
}

/**
 * Record a migration as applied with an immutable plain INSERT.
 * No ON CONFLICT or UPDATE: any unexpected filename conflict must fail.
 */
export async function recordAppliedMigration(client, filename, checksum) {
  await client.query(
    `INSERT INTO ${LEDGER_TABLE} (filename, checksum) VALUES ($1, $2)`,
    [filename, checksum]
  );
}

/**
 * Run a single migration file. The file manages its own transaction.
 */
export async function runMigrationFile(client, migration) {
  await client.query(migration.content);
  await recordAppliedMigration(client, migration.filename, migration.checksum);
}

/**
 * Core migration runner.
 *
 * @param {object} options
 * @param {object} options.pool - pg Pool-like object with connect() returning a client-like object.
 * @param {string} [options.migrationsDir] - directory containing migration files.
 * @returns {Promise<{applied: string[], skipped: string[], rejected: string[]}>}
 */
export async function runMigrations({ pool, migrationsDir = MIGRATIONS_DIR }) {
  const client = await pool.connect();
  let lockAcquired = false;
  let primaryError = null;
  let unlockError = null;
  const result = { applied: [], skipped: [], rejected: [] };

  try {
    lockAcquired = await acquireAdvisoryLock(client);

    await bootstrapLedger(client);
    const migrations = await discoverMigrations(migrationsDir);
    const applied = await loadAppliedMigrations(client);

    for (const migration of migrations) {
      const existing = applied.get(migration.filename);
      if (existing) {
        if (existing.checksum !== migration.checksum) {
          result.rejected.push(migration.filename);
          throw new Error(
            `Migration ${migration.filename} has changed since it was applied (checksum mismatch). ` +
            `Expected ${existing.checksum}, got ${migration.checksum}.`
          );
        }
        result.skipped.push(migration.filename);
        continue;
      }

      await runMigrationFile(client, migration);
      result.applied.push(migration.filename);
    }
  } catch (err) {
    primaryError = err;
  } finally {
    if (lockAcquired) {
      try {
        await releaseAdvisoryLock(client);
      } catch (err) {
        unlockError = err;
      }
    }
    client.release();
  }

  if (primaryError) {
    if (unlockError) {
      // Attach unlock failure without replacing the primary error
      primaryError.unlockError = unlockError;
    }
    throw primaryError;
  }
  if (unlockError) {
    throw unlockError;
  }
  return result;
}

/**
 * Thin CLI entrypoint.
 */
async function main() {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await runMigrations({ pool });
    console.log(`Applied: ${result.applied.join(", ") || "(none)"}`);
    console.log(`Skipped: ${result.skipped.join(", ") || "(none)"}`);
    if (result.rejected.length > 0) {
      console.error(`Rejected: ${result.rejected.join(", ")}`);
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

// Only run main when executed directly (not when imported by tests)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

export { MIGRATIONS_DIR, LEDGER_TABLE, ADVISORY_LOCK_KEY };
