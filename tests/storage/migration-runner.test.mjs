import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  discoverMigrations,
  MIGRATIONS_DIR,
  parseCliOptions,
  runMigrations,
  sha256Hex,
  VALIDATION_ONLY_MIGRATION,
} from "../../infra/migrations/run-migrations.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Create a fake pg Pool/Client that records queries and returns canned results.
 */
function createFakePool({ appliedRows = [], failOnQuery = null, failUnlock = false } = {}) {
  const queries = [];
  const events = { connectCalls: 0 };
  const client = {
    released: false,
    async query(sql, params) {
      queries.push({ sql, params });
      if (failOnQuery && sql.includes(failOnQuery)) {
        throw new Error(`Simulated failure on: ${failOnQuery}`);
      }
      if (sql.includes("pg_advisory_lock")) {
        return { rows: [] };
      }
      if (sql.includes("pg_advisory_unlock")) {
        if (failUnlock) {
          throw new Error("Simulated unlock failure");
        }
        return { rows: [] };
      }
      if (sql.includes("SELECT filename, checksum, applied_at")) {
        return { rows: appliedRows };
      }
      if (sql.includes("CREATE TABLE IF NOT EXISTS infrastructure.schema_migrations")) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO infrastructure.schema_migrations")) {
        return { rows: [] };
      }
      // Migration SQL execution
      return { rows: [] };
    },
    release() {
      this.released = true;
    },
  };
  const pool = {
    async connect() {
      events.connectCalls += 1;
      return client;
    },
  };
  return { pool, client, queries, events };
}

async function createTempMigrationsDir(files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-runner-"));
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content, "utf8");
  }
  return dir;
}

test("discoverMigrations returns files in lexical order with checksums", async () => {
  const dir = await createTempMigrationsDir({
    "0002_second.sql": "SELECT 2;",
    "0001_first.sql": "SELECT 1;",
    "0003_third.sql": "SELECT 3;",
    "not-a-migration.txt": "ignore me",
    "README.md": "ignore me too",
  });
  try {
    const migrations = await discoverMigrations(dir);
    assert.deepEqual(
      migrations.map((m) => m.filename),
      ["0001_first.sql", "0002_second.sql", "0003_third.sql"]
    );
    assert.equal(migrations[0].checksum, sha256Hex("SELECT 1;"));
    assert.equal(migrations[0].checksum.length, 64);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runMigrations applies new migrations in lexical order and records them", async () => {
  const dir = await createTempMigrationsDir({
    "0001_first.sql": "SELECT 1;",
    "0002_second.sql": "SELECT 2;",
  });
  const { pool, client, queries } = createFakePool();
  try {
    const result = await runMigrations({ pool, migrationsDir: dir });
    assert.deepEqual(result.applied, ["0001_first.sql", "0002_second.sql"]);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.rejected, []);
    assert.equal(client.released, true);

    // Verify order: lock, bootstrap, select applied, run 0001, record 0001, run 0002, record 0002, unlock
    const sqls = queries.map((q) => q.sql);
    assert.ok(sqls[0].includes("pg_advisory_lock"));
    assert.ok(sqls[1].includes("CREATE TABLE IF NOT EXISTS infrastructure.schema_migrations"));
    assert.ok(sqls[2].includes("SELECT filename, checksum, applied_at"));
    assert.ok(sqls[3].includes("SELECT 1;"));
    assert.ok(sqls[4].includes("INSERT INTO infrastructure.schema_migrations"));
    assert.ok(sqls[5].includes("SELECT 2;"));
    assert.ok(sqls[6].includes("INSERT INTO infrastructure.schema_migrations"));
    assert.ok(sqls[7].includes("pg_advisory_unlock"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("default runner applies at most 0003 and defers later migration files", async () => {
  const dir = await createTempMigrationsDir({
    "0001_first.sql": "SELECT 1;",
    "0002_second.sql": "SELECT 2;",
    "0003_third.sql": "SELECT 3;",
    "0004_r2_lineage_normalized_observations.sql": "SELECT 4;",
    "0005_future.sql": "SELECT 5;",
  });
  const { pool, queries } = createFakePool();
  try {
    const result = await runMigrations({ pool, migrationsDir: dir });
    assert.deepEqual(result.applied, ["0001_first.sql", "0002_second.sql", "0003_third.sql"]);
    assert.deepEqual(result.deferred, [
      "0004_r2_lineage_normalized_observations.sql",
      "0005_future.sql"
    ]);
    assert.ok(!queries.some((query) => query.sql.includes("SELECT 4;") || query.sql.includes("SELECT 5;")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deferred migrations already in the ledger still have their checksums verified", async () => {
  const dir = await createTempMigrationsDir({
    "0001_first.sql": "SELECT 1;",
    "0004_r2_lineage_normalized_observations.sql": "SELECT 4; -- changed",
  });
  const appliedRows = [{
    filename: "0004_r2_lineage_normalized_observations.sql",
    checksum: sha256Hex("SELECT 4;"),
    applied_at: "2026-07-01T00:00:00Z"
  }];
  const { pool, queries } = createFakePool({ appliedRows });
  try {
    await assert.rejects(runMigrations({ pool, migrationsDir: dir }), /checksum mismatch/);
    assert.ok(!queries.some((query) => query.sql.includes("SELECT 1;")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("0004 authorization is exact, validation-only, and rejected for custom directories before connecting", async () => {
  const dir = await createTempMigrationsDir({
    "0001_first.sql": "SELECT 1;",
    "0004_r2_lineage_normalized_observations.sql": "SELECT 4;",
  });
  const { pool, events } = createFakePool();
  try {
    await assert.rejects(runMigrations({
      pool,
      migrationsDir: dir,
      authorizeValidationOnlyMigration: VALIDATION_ONLY_MIGRATION
    }), /valid only for the repository migrations directory/);
    assert.equal(events.connectCalls, 0);

    await assert.rejects(runMigrations({ pool, migrationAuthorization: "all" }), /Unknown runMigrations option/);
    assert.equal(events.connectCalls, 0);
    await assert.rejects(runMigrations({
      pool,
      authorizeValidationOnlyMigration: "0005_future.sql"
    }), /limited to 0004_r2_lineage_normalized_observations\.sql/);
    assert.equal(events.connectCalls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI accepts only the explicit validation-only 0004 authorization flag", () => {
  assert.deepEqual(parseCliOptions([]), {});
  assert.deepEqual(parseCliOptions(["--authorize-validation-only-0004"]), {
    authorizeValidationOnlyMigration: VALIDATION_ONLY_MIGRATION
  });
  for (const args of [["--all"], ["--authorize-validation-only-0004", "--anything"], ["0004"]]) {
    assert.throws(() => parseCliOptions(args), /Unknown migration runner arguments/);
  }
});

test("real migration directory: default legacy path defers 0004 and explicit authorization selects only it", async () => {
  const migrations = await discoverMigrations(MIGRATIONS_DIR);
  const migration0004 = migrations.find(({ filename }) => filename === VALIDATION_ONLY_MIGRATION);
  assert.ok(migration0004, "the real directory includes 0004 for this gate test");

  const legacy = createFakePool();
  const defaultResult = await runMigrations({ pool: legacy.pool });
  assert.deepEqual(defaultResult.applied, [
    "0001_observation_storage.sql",
    "0002_catalog_lifecycle_and_indexes.sql",
    "0003_source_health.sql"
  ]);
  assert.deepEqual(defaultResult.deferred, [VALIDATION_ONLY_MIGRATION]);
  assert.ok(!legacy.queries.some(({ sql }) => sql === migration0004.content));

  const explicitlyAuthorized = createFakePool();
  const authorizedResult = await runMigrations({
    pool: explicitlyAuthorized.pool,
    authorizeValidationOnlyMigration: VALIDATION_ONLY_MIGRATION
  });
  assert.deepEqual(authorizedResult.applied, [
    "0001_observation_storage.sql",
    "0002_catalog_lifecycle_and_indexes.sql",
    "0003_source_health.sql",
    VALIDATION_ONLY_MIGRATION
  ]);
  assert.deepEqual(authorizedResult.deferred, []);
  assert.equal(explicitlyAuthorized.queries.filter(({ sql }) => sql === migration0004.content).length, 1);
});

test("default worker remains compatible after authorized 0004 and ledger retries never rewrite it", async () => {
  const migrations = await discoverMigrations(MIGRATIONS_DIR);
  const migration0004 = migrations.find(({ filename }) => filename === VALIDATION_ONLY_MIGRATION);
  assert.ok(migration0004);
  const appliedRows = migrations.map(({ filename, checksum }) => ({
    filename,
    checksum,
    applied_at: "2026-09-24T00:00:00Z"
  }));

  const legacyAfter0004 = createFakePool({ appliedRows });
  const legacyResult = await runMigrations({ pool: legacyAfter0004.pool });
  assert.deepEqual(legacyResult.skipped, [
    "0001_observation_storage.sql",
    "0002_catalog_lifecycle_and_indexes.sql",
    "0003_source_health.sql"
  ]);
  assert.deepEqual(legacyResult.deferred, [], "an already applied 0004 is verified but not treated as deferred");
  assert.ok(!legacyAfter0004.queries.some(({ sql }) => sql === migration0004.content));

  const mismatchedRows = appliedRows.map((row) => row.filename === VALIDATION_ONLY_MIGRATION
    ? { ...row, checksum: "0".repeat(64) }
    : row);
  const corruptedLedger = createFakePool({ appliedRows: mismatchedRows });
  await assert.rejects(runMigrations({ pool: corruptedLedger.pool }), /checksum mismatch/);
  assert.ok(!corruptedLedger.queries.some(({ sql }) => sql === migration0004.content));
});

test("runMigrations skips already-applied migrations with matching checksums", async () => {
  const dir = await createTempMigrationsDir({
    "0001_first.sql": "SELECT 1;",
    "0002_second.sql": "SELECT 2;",
  });
  const appliedRows = [
    { filename: "0001_first.sql", checksum: sha256Hex("SELECT 1;"), applied_at: "2026-07-01T00:00:00Z" },
    { filename: "0002_second.sql", checksum: sha256Hex("SELECT 2;"), applied_at: "2026-07-01T00:00:00Z" },
  ];
  const { pool, client } = createFakePool({ appliedRows });
  try {
    const result = await runMigrations({ pool, migrationsDir: dir });
    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.skipped, ["0001_first.sql", "0002_second.sql"]);
    assert.deepEqual(result.rejected, []);
    assert.equal(client.released, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runMigrations rejects a changed applied migration and fails closed", async () => {
  const dir = await createTempMigrationsDir({
    "0001_first.sql": "SELECT 1; -- changed",
  });
  const appliedRows = [
    { filename: "0001_first.sql", checksum: sha256Hex("SELECT 1;"), applied_at: "2026-07-01T00:00:00Z" },
  ];
  const { pool, client, queries } = createFakePool({ appliedRows });
  try {
    await assert.rejects(
      runMigrations({ pool, migrationsDir: dir }),
      /checksum mismatch/
    );
    assert.equal(client.released, true);
    // Verify unlock was attempted even on failure
    assert.ok(queries.some((q) => q.sql.includes("pg_advisory_unlock")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runMigrations releases lock and client when migration execution fails", async () => {
  const dir = await createTempMigrationsDir({
    "0001_first.sql": "SELECT 1;",
  });
  const { pool, client, queries } = createFakePool({ failOnQuery: "SELECT 1;" });
  try {
    await assert.rejects(
      runMigrations({ pool, migrationsDir: dir }),
      /Simulated failure/
    );
    assert.equal(client.released, true);
    assert.ok(queries.some((q) => q.sql.includes("pg_advisory_unlock")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runMigrations propagates unlock failure when no primary error exists", async () => {
  const dir = await createTempMigrationsDir({
    "0001_first.sql": "SELECT 1;",
  });
  const { pool, client } = createFakePool({ failUnlock: true });
  try {
    await assert.rejects(
      runMigrations({ pool, migrationsDir: dir }),
      /Simulated unlock failure/
    );
    assert.equal(client.released, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runMigrations preserves primary error when unlock also fails", async () => {
  const dir = await createTempMigrationsDir({
    "0001_first.sql": "SELECT 1;",
  });
  const { pool, client } = createFakePool({ failOnQuery: "SELECT 1;", failUnlock: true });
  try {
    await assert.rejects(
      runMigrations({ pool, migrationsDir: dir }),
      /Simulated failure on: SELECT 1;/
    );
    assert.equal(client.released, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runMigrations does not attempt unlock when lock acquisition fails", async () => {
  const dir = await createTempMigrationsDir({
    "0001_first.sql": "SELECT 1;",
  });
  const { pool, client, queries } = createFakePool();
  // Override to simulate lock failure
  client.query = async (sql) => {
    queries.push({ sql });
    if (sql.includes("pg_advisory_lock")) {
      throw new Error("Simulated lock failure");
    }
    return { rows: [] };
  };
  try {
    await assert.rejects(
      runMigrations({ pool, migrationsDir: dir }),
      /Simulated lock failure/
    );
    assert.equal(client.released, true);
    assert.ok(!queries.some((q) => q.sql.includes("pg_advisory_unlock")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ledger INSERT is immutable with no conflict rewrite", async () => {
  const dir = await createTempMigrationsDir({
    "0001_first.sql": "SELECT 1;",
  });
  const { pool, queries } = createFakePool();
  try {
    await runMigrations({ pool, migrationsDir: dir });
    const insertQueries = queries.filter((q) => q.sql.includes("INSERT INTO infrastructure.schema_migrations"));
    assert.equal(insertQueries.length, 1);
    assert.ok(!insertQueries[0].sql.includes("ON CONFLICT"));
    assert.ok(!insertQueries[0].sql.includes("UPDATE"));
    assert.match(insertQueries[0].sql, /INSERT INTO infrastructure\.schema_migrations \(filename, checksum\) VALUES \(\$1, \$2\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("module loads without side effects and exports expected symbols", async () => {
  const mod = await import("../../infra/migrations/run-migrations.mjs");
  assert.equal(typeof mod.runMigrations, "function");
  assert.equal(typeof mod.discoverMigrations, "function");
  assert.equal(typeof mod.sha256Hex, "function");
  assert.equal(typeof mod.bootstrapLedger, "function");
  assert.equal(typeof mod.acquireAdvisoryLock, "function");
  assert.equal(typeof mod.releaseAdvisoryLock, "function");
  assert.equal(typeof mod.loadAppliedMigrations, "function");
  assert.equal(typeof mod.recordAppliedMigration, "function");
  assert.equal(typeof mod.runMigrationFile, "function");
  assert.equal(mod.LEDGER_TABLE, "infrastructure.schema_migrations");
  assert.equal(typeof mod.ADVISORY_LOCK_KEY, "number");
});

test("real migration directory is discoverable and 0001 is present", async () => {
  const migrations = await discoverMigrations(path.join(root, "infra/migrations"));
  assert.ok(migrations.some((m) => m.filename === "0001_observation_storage.sql"));
  assert.ok(migrations.every((m) => m.checksum.length === 64));
});
