import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const LEDGER_TABLE = "infrastructure.schema_migrations";
const ADVISORY_LOCK_KEY = 727001; // arbitrary project-specific key
const DEFAULT_MAX_MIGRATION_VERSION = 3;
const VALIDATION_ONLY_MIGRATION = "0004_r2_lineage_normalized_observations.sql";
const RUN_MIGRATION_OPTIONS = new Set([
  "pool",
  "migrationsDir",
  "authorizeValidationOnlyMigration"
]);

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
 * @param {string} [options.authorizeValidationOnlyMigration] - exact 0004 filename; only valid for this repository's migration directory.
 * @returns {Promise<{applied: string[], skipped: string[], deferred: string[], rejected: string[]}>}
 */
export async function runMigrations(options = {}) {
  const { pool, migrationsDir = MIGRATIONS_DIR, authorizeValidationOnlyMigration } = validateRunOptions(options);
  const client = await pool.connect();
  let lockAcquired = false;
  let primaryError = null;
  let unlockError = null;
  const result = { applied: [], skipped: [], deferred: [], rejected: [] };

  try {
    lockAcquired = await acquireAdvisoryLock(client);

    await bootstrapLedger(client);
    const migrations = await discoverMigrations(migrationsDir);
    const applied = await loadAppliedMigrations(client);
    const migrationsByName = new Map(migrations.map((migration) => [migration.filename, migration]));

    // Validate the full discovered ledger, including migrations currently outside the
    // default execution ceiling. A deferred migration must not become a checksum blind spot.
    for (const [filename, existing] of applied) {
      const migration = migrationsByName.get(filename);
      if (!migration) {
        result.rejected.push(filename);
        throw new Error(`Applied migration ${filename} is missing from the migration directory.`);
      }
      if (existing.checksum !== migration.checksum) {
        result.rejected.push(filename);
        throw new Error(
          `Migration ${filename} has changed since it was applied (checksum mismatch). ` +
          `Expected ${existing.checksum}, got ${migration.checksum}.`
        );
      }
    }

    const explicitlyAuthorized = authorizeValidationOnlyMigration === VALIDATION_ONLY_MIGRATION;
    const authorizedMigrations = migrations.filter((migration) => {
      const version = Number(migration.filename.match(/^(\d+)_/)[1]);
      return version <= DEFAULT_MAX_MIGRATION_VERSION ||
        (explicitlyAuthorized && migration.filename === VALIDATION_ONLY_MIGRATION);
    });
    const authorizedNames = new Set(authorizedMigrations.map((migration) => migration.filename));
    result.deferred.push(...migrations
      .filter((migration) => !authorizedNames.has(migration.filename) && !applied.has(migration.filename))
      .map((migration) => migration.filename));

    for (const migration of authorizedMigrations) {
      const existing = applied.get(migration.filename);
      if (existing) {
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

function validateRunOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("runMigrations options must be an object.");
  }
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string" || !RUN_MIGRATION_OPTIONS.has(key)) {
      throw new TypeError(`Unknown runMigrations option: ${String(key)}.`);
    }
  }
  if (!options.pool || typeof options.pool.connect !== "function") {
    throw new TypeError("runMigrations requires a pool with connect().");
  }

  const migrationsDir = options.migrationsDir ?? MIGRATIONS_DIR;
  if (typeof migrationsDir !== "string") {
    throw new TypeError("migrationsDir must be a path string.");
  }
  const resolvedMigrationsDir = path.resolve(migrationsDir);
  const authorization = options.authorizeValidationOnlyMigration;
  if (authorization !== undefined && authorization !== VALIDATION_ONLY_MIGRATION) {
    throw new Error(`Migration authorization is limited to ${VALIDATION_ONLY_MIGRATION}.`);
  }
  if (authorization === VALIDATION_ONLY_MIGRATION && resolvedMigrationsDir !== MIGRATIONS_DIR) {
    throw new Error("The validation-only 0004 authorization is valid only for the repository migrations directory.");
  }
  return {
    pool: options.pool,
    migrationsDir: resolvedMigrationsDir,
    authorizeValidationOnlyMigration: authorization
  };
}

function parseCliOptions(args) {
  if (args.length === 0) return {};
  if (args.length === 1 && args[0] === "--authorize-validation-only-0004") {
    return { authorizeValidationOnlyMigration: VALIDATION_ONLY_MIGRATION };
  }
  throw new Error(`Unknown migration runner arguments: ${args.join(" ") || "(empty)"}.`);
}

/**
 * Thin CLI entrypoint.
 */
async function main() {
  const options = parseCliOptions(process.argv.slice(2));
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await runMigrations({ pool, ...options });
    console.log(`Applied: ${result.applied.join(", ") || "(none)"}`);
    console.log(`Skipped: ${result.skipped.join(", ") || "(none)"}`);
    console.log(`Deferred without validation-only authorization: ${result.deferred.join(", ") || "(none)"}`);
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

export {
  MIGRATIONS_DIR,
  LEDGER_TABLE,
  ADVISORY_LOCK_KEY,
  DEFAULT_MAX_MIGRATION_VERSION,
  VALIDATION_ONLY_MIGRATION,
  parseCliOptions
};
