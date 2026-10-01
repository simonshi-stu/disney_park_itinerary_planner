import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverMigrations } from "../../infra/migrations/run-migrations.mjs";
import {
  normalizeDatabaseTarget,
  assertSafeRestoreTarget,
  verifyRestoredStorage,
} from "../../infra/restore/verify-restored-storage.mjs";

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../infra/migrations"
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

const OPTIONAL_0004 = "0004_r2_lineage_normalized_observations.sql";
const REQUIRED_0004_RELATIONS = [
  "ingestion.raw_archive_line_references",
  "observations.normalized_wait_observations_v2",
  "catalog.catalog_entry_snapshots",
];
const REQUIRED_0004_TRIGGERS = [
  ["ingestion.raw_archive_line_references", "raw_archive_line_references_are_immutable"],
  ["observations.normalized_wait_observations_v2", "normalized_wait_observations_v2_are_immutable"],
  ["catalog.catalog_entry_snapshots", "catalog_entry_snapshots_are_immutable"],
];

function makeFakeClient({
  missingRelations = [],
  missingTriggers = [],
  includeV2Relations = false,
  migrationRows = [],
} = {}) {
  const available = new Set(
    [...REQUIRED_RELATIONS, ...(includeV2Relations ? REQUIRED_0004_RELATIONS : [])]
      .filter((r) => !missingRelations.includes(r))
  );
  return {
    async query(sql, params = []) {
      const text = sql.trim();
      if (
        text === "BEGIN TRANSACTION READ ONLY" ||
        text === "COMMIT" ||
        text === "ROLLBACK"
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (text.startsWith("SELECT to_regclass($1)")) {
        const relation = params[0];
        return {
          rows: [{ regclass: available.has(relation) ? relation : null }],
          rowCount: 1,
        };
      }
      if (text.includes("FROM infrastructure.schema_migrations")) {
        return { rows: migrationRows, rowCount: migrationRows.length };
      }
      if (text.includes("FROM pg_trigger")) {
        const [table, trigger] = params;
        const triggerKey = `${table}:${trigger}`;
        const hasTrigger =
          available.has(table) &&
          !missingTriggers.includes(triggerKey) &&
          ([
            ["ingestion.raw_archives", "raw_archives_are_immutable"],
            ["ingestion.raw_wait_observations", "raw_wait_observations_are_immutable"],
            ...REQUIRED_0004_TRIGGERS,
          ].some(([knownTable, knownTrigger]) => knownTable === table && knownTrigger === trigger));
        return { rows: hasTrigger ? [{}] : [], rowCount: hasTrigger ? 1 : 0 };
      }
      if (text.includes("AS orphan_count")) {
        return { rows: [{ orphan_count: 0 }], rowCount: 1 };
      }
      if (text.includes("AS violation_count")) {
        return { rows: [{ violation_count: 0 }], rowCount: 1 };
      }
      if (text.includes("AS archive_count")) {
        return {
          rows: [{ archive_count: 3, observation_count: 42 }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected SQL: ${text}`);
    },
  };
}

// --- normalizeDatabaseTarget ---

test("normalizeDatabaseTarget normalizes host, port, and database", () => {
  const target = normalizeDatabaseTarget(
    "postgres://user:pass@DB.example.com:5433/mydb?sslmode=require"
  );
  assert.deepEqual(target, {
    host: "db.example.com",
    port: 5433,
    database: "mydb",
  });
});

test("normalizeDatabaseTarget defaults port to 5432 and decodes database", () => {
  const target = normalizeDatabaseTarget("postgresql://u:p@localhost/my%20db");
  assert.deepEqual(target, {
    host: "localhost",
    port: 5432,
    database: "my db",
  });
});

test("normalizeDatabaseTarget rejects non-postgres protocols", () => {
  assert.throws(
    () => normalizeDatabaseTarget("mysql://localhost/db"),
    /unsupported database URL protocol/
  );
});

test("normalizeDatabaseTarget rejects empty string", () => {
  assert.throws(() => normalizeDatabaseTarget(""), /non-empty string/);
});

// --- assertSafeRestoreTarget ---

test("assertSafeRestoreTarget rejects same target with different credentials", () => {
  assert.throws(
    () =>
      assertSafeRestoreTarget(
        "postgres://prod_user:secret@db.example.com:5432/app",
        "postgres://restore_user:other@db.example.com:5432/app"
      ),
    /is the same as DATABASE_URL/
  );
});

test("assertSafeRestoreTarget rejects same target with different query strings", () => {
  assert.throws(
    () =>
      assertSafeRestoreTarget(
        "postgres://u:p@db.example.com:5432/app?sslmode=require",
        "postgres://u:p@db.example.com:5432/app?connect_timeout=5"
      ),
    /is the same as DATABASE_URL/
  );
});

test("assertSafeRestoreTarget allows different database", () => {
  assert.doesNotThrow(() =>
    assertSafeRestoreTarget(
      "postgres://u:p@db.example.com:5432/prod",
      "postgres://u:p@db.example.com:5432/restore"
    )
  );
});

test("assertSafeRestoreTarget allows different host", () => {
  assert.doesNotThrow(() =>
    assertSafeRestoreTarget(
      "postgres://u:p@prod.example.com:5432/app",
      "postgres://u:p@restore.example.com:5432/app"
    )
  );
});

test("assertSafeRestoreTarget requires RESTORE_DATABASE_URL", () => {
  assert.throws(
    () =>
      assertSafeRestoreTarget(
        "postgres://u:p@db.example.com:5432/app",
        undefined
      ),
    /RESTORE_DATABASE_URL is required/
  );
});

test("assertSafeRestoreTarget returns early when DATABASE_URL is absent", () => {
  assert.doesNotThrow(() =>
    assertSafeRestoreTarget(undefined, "postgres://u:p@db.example.com:5432/app")
  );
});

// --- verifyRestoredStorage ---

test("verifyRestoredStorage returns ok report for healthy storage", async () => {
  const migrations = await discoverMigrations(MIGRATIONS_DIR);
  const migrationRows = migrations.map((m) => ({
    filename: m.filename,
    checksum: m.checksum,
  }));
  const client = makeFakeClient({ migrationRows, includeV2Relations: true });
  const report = await verifyRestoredStorage(client);

  assert.equal(report.status, "ok");
  assert.equal(report.failures.length, 0);
  assert.equal(report.checks.length, 8);
  assert.ok(report.run_id);
  assert.ok(report.checked_at);
  assert.ok(report.checks.every((c) => c.passed));
});

test("verifyRestoredStorage reports missing relations as failed", async () => {
  const migrations = await discoverMigrations(MIGRATIONS_DIR);
  const migrationRows = migrations.map((m) => ({
    filename: m.filename,
    checksum: m.checksum,
  }));
  const client = makeFakeClient({
    missingRelations: ["catalog.parks", "ingestion.raw_archives"],
    includeV2Relations: true,
    migrationRows,
  });
  const report = await verifyRestoredStorage(client);

  assert.equal(report.status, "failed");
  assert.ok(report.failures.length > 0);

  const relationsCheck = report.checks.find(
    (c) => c.name === "required_relations"
  );
  assert.equal(relationsCheck.passed, false);
  assert.deepEqual(relationsCheck.detail.missing, [
    "catalog.parks",
    "ingestion.raw_archives",
  ]);

  const rawCountsCheck = report.checks.find((c) => c.name === "raw_counts");
  assert.equal(rawCountsCheck.passed, false);
  assert.deepEqual(rawCountsCheck.detail, {
    reason: "required relations missing",
  });
});

test("verifyRestoredStorage rolls back on unexpected query failure", async () => {
  const migrations = await discoverMigrations(MIGRATIONS_DIR);
  const migrationRows = migrations.map((m) => ({
    filename: m.filename,
    checksum: m.checksum,
  }));
  const baseClient = makeFakeClient({ migrationRows, includeV2Relations: true });
  const executedSql = [];
  const client = {
    async query(sql, params = []) {
      executedSql.push(sql.trim());
      if (sql.includes("AS orphan_count")) {
        throw new Error("unexpected query failure");
      }
      return baseClient.query(sql, params);
    },
  };

  await assert.rejects(
    () => verifyRestoredStorage(client),
    /unexpected query failure/
  );

  assert.ok(executedSql.includes("BEGIN TRANSACTION READ ONLY"));
  assert.ok(executedSql.includes("ROLLBACK"));
  assert.ok(!executedSql.includes("COMMIT"));
});

test("verifyRestoredStorage healthy verification issues only read-only SQL", async () => {
  const migrations = await discoverMigrations(MIGRATIONS_DIR);
  const migrationRows = migrations.map((m) => ({
    filename: m.filename,
    checksum: m.checksum,
  }));
  const baseClient = makeFakeClient({ migrationRows, includeV2Relations: true });
  const executedSql = [];
  const client = {
    async query(sql, params = []) {
      executedSql.push(sql.trim());
      return baseClient.query(sql, params);
    },
  };

  const report = await verifyRestoredStorage(client);

  assert.equal(report.status, "ok");
  assert.ok(executedSql.includes("BEGIN TRANSACTION READ ONLY"));
  assert.ok(executedSql.includes("COMMIT"));

  const forbiddenTokens = [
    "INSERT",
    "UPDATE",
    "DELETE",
    "CREATE",
    "DROP",
    "ALTER",
    "TRUNCATE",
    "pg_restore",
  ];
  const combinedSql = executedSql.join("\n").toUpperCase();
  for (const token of forbiddenTokens) {
    assert.ok(
      !combinedSql.includes(token.toUpperCase()),
      `healthy verification must not issue ${token}`
    );
  }
});

test("verifyRestoredStorage accepts the legacy 0003 ledger and reports gated 0004 as deferred optional", async () => {
  const migrations = await discoverMigrations(MIGRATIONS_DIR);
  const migrationRows = migrations
    .filter((migration) => migration.filename !== OPTIONAL_0004)
    .map(({ filename, checksum }) => ({ filename, checksum }));
  const client = makeFakeClient({ migrationRows });

  const report = await verifyRestoredStorage(client);

  assert.equal(report.status, "ok");
  const ledgerCheck = report.checks.find((check) => check.name === "migration_ledger");
  assert.equal(ledgerCheck.passed, true);
  assert.deepEqual(ledgerCheck.detail.missing, []);
  assert.deepEqual(ledgerCheck.detail.deferred_optional, [OPTIONAL_0004]);
  assert.ok(!report.checks.some((check) => check.name.startsWith("required_0004_")));

  const missingLegacyMigration = makeFakeClient({
    migrationRows: migrationRows.filter(
      (migration) => migration.filename !== "0003_source_health.sql"
    ),
  });
  const missingLegacyReport = await verifyRestoredStorage(missingLegacyMigration);
  assert.equal(missingLegacyReport.status, "failed");
  assert.ok(missingLegacyReport.checks
    .find((check) => check.name === "migration_ledger")
    .detail.missing.includes("0003_source_health.sql"));
});

test("verifyRestoredStorage fails closed when an applied 0004 checksum differs", async () => {
  const migrations = await discoverMigrations(MIGRATIONS_DIR);
  const migrationRows = migrations.map((migration) => ({
    filename: migration.filename,
    checksum: migration.filename === OPTIONAL_0004 ? "0".repeat(64) : migration.checksum,
  }));
  const client = makeFakeClient({ migrationRows, includeV2Relations: true });

  const report = await verifyRestoredStorage(client);

  assert.equal(report.status, "failed");
  const ledgerCheck = report.checks.find((check) => check.name === "migration_ledger");
  assert.equal(ledgerCheck.passed, false);
  assert.deepEqual(ledgerCheck.detail.checksum_mismatch, [OPTIONAL_0004]);
  assert.equal(report.checks.find((check) => check.name === "required_0004_relations").passed, true);
  assert.equal(report.checks.find((check) => check.name === "required_0004_immutability_triggers").passed, true);
});

test("verifyRestoredStorage requires 0004 relations and immutability triggers when its ledger row exists", async () => {
  const migrations = await discoverMigrations(MIGRATIONS_DIR);
  const migrationRows = migrations.map(({ filename, checksum }) => ({ filename, checksum }));
  const missingRelationClient = makeFakeClient({
    migrationRows,
    includeV2Relations: true,
    missingRelations: ["observations.normalized_wait_observations_v2"],
  });

  const missingRelationReport = await verifyRestoredStorage(missingRelationClient);
  assert.equal(missingRelationReport.status, "failed");
  assert.deepEqual(
    missingRelationReport.checks.find((check) => check.name === "required_0004_relations").detail.missing,
    ["observations.normalized_wait_observations_v2"]
  );

  const missingTriggerClient = makeFakeClient({
    migrationRows,
    includeV2Relations: true,
    missingTriggers: ["catalog.catalog_entry_snapshots:catalog_entry_snapshots_are_immutable"],
  });
  const missingTriggerReport = await verifyRestoredStorage(missingTriggerClient);
  assert.equal(missingTriggerReport.status, "failed");
  assert.deepEqual(
    missingTriggerReport.checks.find((check) => check.name === "required_0004_immutability_triggers").detail.missing,
    [{ table: "catalog.catalog_entry_snapshots", trigger: "catalog_entry_snapshots_are_immutable" }]
  );
});
