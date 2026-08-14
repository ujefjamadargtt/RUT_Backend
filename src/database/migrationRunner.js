'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const logger = require('../utils/logger');

/**
 * Automatic Database Migration Runner
 *
 * Runs every *.sql file in database/migrations/ against the database on
 * server startup, tracking what's already been applied in a
 * `schema_migrations` table so each file only ever runs once. Designed to
 * be called once, early in server.js, before the HTTP server starts
 * accepting requests — see runMigrations()'s doc comment below for the
 * full behavior contract.
 *
 * On a completely empty database (no tables at all — not even
 * database/schema.sql's baseline), this also applies schema.sql itself
 * first, automatically, before running the dated migrations — see
 * applySchemaBaseline() below. No manual `psql -f database/schema.sql` step
 * is required for a brand-new environment; running the server is enough.
 *
 * File naming convention (unchanged from how migrations were already being
 * written in this repo): `YYYYMMDD_description.sql`, so a plain
 * lexicographic sort of filenames is already chronological order.
 * `*_rollback.sql` files are companions to their forward migration, meant
 * to be run manually if something needs to be undone — they are never
 * picked up by this runner.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, '../../database/migrations');
const SCHEMA_BASELINE_PATH = path.resolve(__dirname, '../../database/schema.sql');

// Synthetic schema_migrations name for the schema.sql bootstrap step (see
// applySchemaBaseline below). Deliberately dated before every real migration
// file so it always sorts first in any audit query against the table, and
// deliberately NOT a filename listMigrationFiles() can ever produce (it only
// reads database/migrations/, and this lives in database/schema.sql), so it
// can never collide with, or be mistaken for, a real migration file.
const SCHEMA_BASELINE_NAME = '00000000_schema_sql_baseline';

// Arbitrary but fixed 64-bit key for pg_advisory_lock, namespacing this
// app's migration lock so it can never collide with an unrelated advisory
// lock some other tool/app might take on the same database.
const ADVISORY_LOCK_KEY = 7412583690;

/**
 * @returns {string[]} every migration filename, excluding rollbacks, sorted
 *   chronologically (filename date prefix order).
 */
function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];

  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('_rollback.sql'))
    .sort();
}

/**
 * Creates the schema_migrations tracking table if it doesn't already exist.
 * @param {import('sequelize').Sequelize} sequelize
 * @returns {Promise<boolean>} true if the table was just created (first run
 *   ever against this database), false if it already existed.
 */
async function ensureMigrationsTable(sequelize) {
  const [[{ existed }]] = await sequelize.query(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS existed"
  );

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  return !existed;
}

/**
 * @param {import('sequelize').Sequelize} sequelize
 * @returns {Promise<Set<string>>} filenames already recorded as applied
 */
async function getAppliedMigrations(sequelize) {
  const [rows] = await sequelize.query('SELECT name FROM schema_migrations');
  return new Set(rows.map((r) => r.name));
}

/**
 * Distinguishes the two situations that both present as "schema_migrations
 * doesn't exist yet" (isFirstRun === true in runMigrations):
 *
 *  1. An OLD database that predates this runner entirely — every migration
 *     file on disk was already applied by hand over the course of
 *     development, same as this project always worked before the runner
 *     existed. Here, baselining (record as applied, don't re-execute) is
 *     correct — re-running them for real would mean re-applying changes
 *     already live and could fail or duplicate data.
 *
 *  2. A BRAND NEW database that just had database/schema.sql run against it
 *     (the documented manual first step for any new environment — see
 *     database/README.md) and is starting this server for the very first
 *     time. schema.sql only defines the ORIGINAL baseline tables; every
 *     table/column introduced since (companies, service_categories,
 *     company_id, etc.) exists ONLY inside database/migrations/*.sql. If
 *     this case is (mis)treated the same as case 1 and baselined, every one
 *     of those migrations gets marked "applied" without ever actually
 *     running — silently leaving the new environment missing multi-tenancy,
 *     service categories, and everything else those files add. This is
 *     exactly the class of bug this project hit in practice: schema drift
 *     between "what schema.sql describes" and "what migrations actually
 *     built," invisible until something tries to use the missing piece.
 *
 * `companies` is the correct discriminator: it's created exclusively by
 * 20260728_add_company_tenancy_schema.sql and appears nowhere in schema.sql.
 * If it already exists the moment we detect isFirstRun, this is case 1 —
 * some migrations' real-world effects already exist even though this runner
 * has never tracked them. If it doesn't exist, this is case 2, and every
 * migration must actually run, not be baselined.
 *
 * @param {import('sequelize').Sequelize} sequelize
 * @returns {Promise<boolean>}
 */
async function hasPreRunnerMigrationHistory(sequelize) {
  const [[{ exists }]] = await sequelize.query(
    "SELECT to_regclass('public.companies') IS NOT NULL AS exists"
  );
  return exists;
}

/**
 * Distinguishes a genuinely blank database (no tables at all yet — not even
 * database/schema.sql's baseline) from one where schema.sql has already
 * been applied (by hand, per the previously-documented setup flow) but no
 * dated migration has run yet.
 *
 * `roles` is the discriminator: it is the very first table schema.sql
 * creates, nothing else in this schema can exist without it (employees,
 * users, clients, service_pos, timesheets, etc. all directly or indirectly
 * reference it), and no file in database/migrations/ ever creates it — only
 * schema.sql does. If it's missing, schema.sql itself has never touched
 * this database.
 *
 * @param {import('sequelize').Sequelize} sequelize
 * @returns {Promise<boolean>}
 */
async function isCompletelyEmptyDatabase(sequelize) {
  const [[{ exists }]] = await sequelize.query(
    "SELECT to_regclass('public.roles') IS NOT NULL AS exists"
  );
  return !exists;
}

/**
 * Applies database/schema.sql's DDL — the 20-table pre-migration-runner
 * baseline (roles, employees, users, clients, service_types, service_pos,
 * sub_projects, timesheets, audit_logs, ai_insights, etc.) — directly
 * against the database, then records a synthetic schema_migrations row for
 * it. Called exactly once, only when isCompletelyEmptyDatabase() finds no
 * `roles` table: a truly blank database that has never had schema.sql run
 * against it by hand (previously a required manual first step — see
 * database/README.md).
 *
 * This is intentionally NOT turned into a new file under
 * database/migrations/ — schema.sql already fully defines every table those
 * dated migrations build on (Employees, Timesheet, Client Master, Service
 * PO Master, etc.), so adding a migration file with the same CREATE TABLE
 * statements would just be a duplicate. schema.sql's own DDL is already
 * written with IF NOT EXISTS throughout, so applying it here is always
 * safe, including on a database where it (or some of it) already exists by
 * some other path. The synthetic name recorded below exists purely so this
 * step is visible in schema_migrations' audit trail — listMigrationFiles()
 * can never produce that name, so it can never be re-applied as if it were
 * a real migration file.
 *
 * @param {import('sequelize').Sequelize} sequelize
 */
async function applySchemaBaseline(sequelize) {
  logger.info(
    'Migrations: completely empty database detected (no "roles" table) — applying database/schema.sql baseline first.'
  );
  console.log('[migrations] Empty database detected — applying database/schema.sql baseline.');

  const sql = fs.readFileSync(SCHEMA_BASELINE_PATH, 'utf8');

  try {
    await sequelize.query(sql);
  } catch (err) {
    throw new Error(`Schema baseline failed: database/schema.sql — ${err.message}`);
  }

  await sequelize.query('INSERT INTO schema_migrations (name) VALUES (:name)', {
    replacements: { name: SCHEMA_BASELINE_NAME },
  });
}

/**
 * Records every currently-existing migration file as already applied,
 * WITHOUT executing its SQL. Called exactly once — only when
 * ensureMigrationsTable() reports the tracking table was just created,
 * meaning this database predates the automatic migration runner and its
 * schema already reflects every file present today (they were applied by
 * hand over the course of development, same as every migration in this
 * repo has been so far). Re-running their SQL now would be redundant at
 * best and unsafe at worst for any migration not written idempotently.
 * Any migration file added AFTER this baseline point is a genuinely new,
 * never-applied migration and will run normally on a later startup.
 *
 * @param {import('sequelize').Sequelize} sequelize
 * @param {string[]} files
 */
async function baselineExistingMigrations(sequelize, files) {
  if (files.length === 0) return;

  logger.info(
    `Migrations: first run detected — baselining ${files.length} existing migration(s) as already applied (not re-executed).`
  );
  console.log(
    `[migrations] First run detected — baselining ${files.length} existing migration(s) as already applied.`
  );

  for (const file of files) {
    await sequelize.query('INSERT INTO schema_migrations (name) VALUES (:name)', {
      replacements: { name: file },
    });
  }
}

/**
 * Applies a single migration file's SQL exactly as written (one
 * `sequelize.query()` call over the whole file), then records it in
 * schema_migrations. Migration files in this repo are written either as
 * a single statement/DO block, or as their own explicit `BEGIN; ... COMMIT;`
 * — this runner never wraps a second transaction around the file, since
 * nesting an outer transaction around a file that issues its own BEGIN/COMMIT
 * would cause Postgres to commit the outer transaction early on the file's
 * own COMMIT. Each file is responsible for its own atomicity, matching how
 * these files have already been written and manually run throughout this
 * project.
 *
 * @param {import('sequelize').Sequelize} sequelize
 * @param {string} file
 */
async function applyMigration(sequelize, file) {
  logger.info(`Applying migration: ${file}`);
  console.log(`[migrations] Applying migration: ${file}`);

  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

  try {
    await sequelize.query(sql);
  } catch (err) {
    throw new Error(`Migration failed: ${file} — ${err.message}`);
  }

  await sequelize.query('INSERT INTO schema_migrations (name) VALUES (:name)', {
    replacements: { name: file },
  });
}

/**
 * Checks for and applies every pending migration, exactly once, guarded by
 * a Postgres session-level advisory lock so two server instances starting
 * at the same instant can never both run migrations concurrently — the
 * second instance blocks on pg_advisory_lock until the first releases it,
 * then finds every migration already applied and exits immediately as a
 * no-op. The lock is held on its own dedicated `pg` client (NOT through
 * Sequelize's connection pool), since an advisory lock is tied to the
 * specific database session that acquired it — a pooled connection could
 * hand the unlock call to a different underlying connection than the one
 * that locked, and the lock would never actually release. If the process
 * crashes while holding the lock, Postgres releases it automatically when
 * that connection drops, so there is no permanent-deadlock risk.
 *
 * Contract:
 *  - Logs "Checking pending migrations..." before doing anything else.
 *  - If this is the first time this database has seen the runner, every
 *    migration file currently on disk is baselined as already-applied (see
 *    baselineExistingMigrations) rather than re-executed.
 *  - Otherwise, every migration file not yet in schema_migrations is
 *    applied in chronological (filename) order.
 *  - If there is nothing to do, logs "No pending migrations found." and
 *    returns normally.
 *  - If any migration throws, this function logs "Migration failed: <error>"
 *    and RE-THROWS — the caller (server.js) must let that abort startup
 *    rather than swallow it, so the app never runs against a partially
 *    migrated database.
 *  - On full success, logs "Migration completed successfully."
 *
 * @param {import('sequelize').Sequelize} sequelize - the app's normal
 *   Sequelize instance; migrations run through it so they share the same
 *   connection settings (host/port/credentials/SSL) as the rest of the app.
 */
async function runMigrations(sequelize) {
  logger.info('Checking pending migrations...');
  console.log('[migrations] Checking pending migrations...');

  // Built directly from the same env vars src/config/database.js uses to
  // construct its own Sequelize instance — sequelize.config does not
  // reliably expose database/username/password back out in this project's
  // setup, so introspecting the passed-in instance isn't an option here.
  const lockClient = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: process.env.NODE_ENV === 'production' ? { require: true, rejectUnauthorized: false } : false,
  });
  await lockClient.connect();
  await lockClient.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);

  try {
    const isFirstRun = await ensureMigrationsTable(sequelize);
    const allFiles = listMigrationFiles();

    if (isFirstRun) {
      const preExisting = await hasPreRunnerMigrationHistory(sequelize);

      if (preExisting) {
        await baselineExistingMigrations(sequelize, allFiles);
        logger.info('Migration completed successfully.');
        console.log('[migrations] Migration completed successfully.');
        return;
      }

      if (await isCompletelyEmptyDatabase(sequelize)) {
        await applySchemaBaseline(sequelize);
      }

      logger.info(
        `Migrations: first run on a brand-new database detected (no "companies" table yet) — ` +
        `applying all ${allFiles.length} migration(s) for real instead of baselining.`
      );
      console.log(
        `[migrations] Brand-new database detected — applying all ${allFiles.length} migration(s) for real.`
      );
      // Falls through to the normal pending-migration loop below, with
      // `applied` empty, so every file on disk runs in order.
    }

    const applied = await getAppliedMigrations(sequelize);
    const pending = allFiles.filter((f) => !applied.has(f));

    if (pending.length === 0) {
      logger.info('No pending migrations found.');
      console.log('[migrations] No pending migrations found.');
      return;
    }

    for (const file of pending) {
      await applyMigration(sequelize, file);
    }

    logger.info('Migration completed successfully.');
    console.log('[migrations] Migration completed successfully.');
  } catch (err) {
    logger.error(`Migration failed: ${err.message}`, { stack: err.stack });
    console.error(`[migrations] Migration failed: ${err.message}`);
    throw err;
  } finally {
    try {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    } finally {
      await lockClient.end();
    }
  }
}

module.exports = {
  runMigrations,
  listMigrationFiles,
  ensureMigrationsTable,
  getAppliedMigrations,
  isCompletelyEmptyDatabase,
  applySchemaBaseline,
};
