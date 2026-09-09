import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  discoverMigrations,
  runMigrations,
  sha256Hex,
} from "../../infra/migrations/run-migrations.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Create a fake pg Pool/Client that records queries and returns canned results.
 */
function createFakePool({ appliedRows = [], failOnQuery = null, failUnlock = false } = {}) {
  const queries = [];
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
      return client;
    },
  };
  return { pool, client, queries };
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
