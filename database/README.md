# RUT Portal — Database Setup

Resource Utilization Tracking · PostgreSQL 14+

---

## Prerequisites

| Requirement | Minimum version |
|-------------|----------------|
| PostgreSQL  | 14.x           |
| psql CLI    | bundled with PostgreSQL |
| Node.js     | 18.x (for bcrypt re-hash step) |

---

## Quick Start

### 1. Create the database and user

Connect to PostgreSQL as a superuser (e.g. `postgres`) and run:

```sql
CREATE USER rut_user WITH PASSWORD 'change_this_password';
CREATE DATABASE rut_portal OWNER rut_user;
GRANT ALL PRIVILEGES ON DATABASE rut_portal TO rut_user;
```

> **Security note:** Pick a strong password and store it only in your `.env` file.
> Never commit credentials to source control.

---

### 2. Configure `.env` and start the server

No manual `psql -f ...` step is required. Copy `.env.example` (or write a new
`.env`, see [Environment Variables](#environment-variables) below) pointing
at the database you just created, then run:

```bash
npm start
```

On a completely empty database, the automatic migration runner
(`src/database/migrationRunner.js`, wired into `server.js`) detects there is
no `roles` table yet, applies `database/schema.sql` (the full baseline
schema — tables, indexes, foreign keys, `updated_at` triggers) itself, then
applies every dated file in `database/migrations/*.sql` in order. All
required master/config data (roles, forms, role-form mappings, RBAC
capabilities) is created by those migrations — no separate seed step is
needed for the app to function. See
[Automatic Migrations](#automatic-migrations) below for the full behavior
contract.

---

### 3. Create your first login

A fresh database has zero users. Provision the initial platform admin with
the dedicated script (safe to re-run — it's a no-op if a platform admin
already exists):

```bash
node scripts/seedPlatformAdmin.js <email> <password>
```

This is the only step that still requires running a command by hand — and
it's an application-provided script, not raw SQL. Log in with that email to
start creating companies, roles, and everything else through the API.

---

### 4. (Optional) Load demo/dummy data

`database/seeds.sql` and `database/rbac_seed.sql` insert sample clients,
employees, timesheets, and legacy-role RBAC rows purely for local
development/demo purposes — they are **not** required and are **not** run
automatically. Apply them by hand only if you want that sample data:

```bash
psql -U rut_user -d rut_portal -f database/seeds.sql
psql -U rut_user -d rut_portal -f database/rbac_seed.sql
```

`seeds.sql`'s admin user (`admin@rutportal.com`) ships with a placeholder
bcrypt hash — regenerate it before relying on that login:

```bash
node -e "require('bcrypt').hash('Admin@123', 12).then(console.log)"
```

---

## Environment Variables

Create a `.env` file at the project root (copy `.env.example` if it exists):

```env
# PostgreSQL
DB_HOST=localhost
DB_PORT=5432
DB_NAME=rut_portal
DB_USER=rut_user
DB_PASSWORD=change_this_password
DB_POOL_MIN=2
DB_POOL_MAX=10

# JWT
JWT_SECRET=replace_with_a_long_random_string
JWT_EXPIRES_IN=15m
JWT_REFRESH_SECRET=replace_with_another_long_random_string
JWT_REFRESH_EXPIRES_IN=7d

# App
NODE_ENV=development
PORT=3000
```

Generate strong secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

---

## Sequelize Setup (reference)

`config/database.js` should read from `process.env`:

```js
module.exports = {
  development: {
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    host:     process.env.DB_HOST,
    port:     Number(process.env.DB_PORT) || 5432,
    dialect:  'postgres',
    pool: {
      min: Number(process.env.DB_POOL_MIN) || 2,
      max: Number(process.env.DB_POOL_MAX) || 10,
    },
    logging: false,
  },
};
```

---

## Automatic Migrations

Every file in `database/migrations/*.sql` (except `*_rollback.sql` files) is
applied **automatically** whenever the server starts — `node server.js` or
`npm start`. There is no manual migration command to run after a deploy.

### How it works

1. On startup, right after the database connection is confirmed and before
   the HTTP server starts listening, the app checks a `schema_migrations`
   tracking table (created automatically the first time) for which
   migration files have already been applied.
2. Any `.sql` file in `database/migrations/` not yet recorded there is
   applied, **in chronological order** — filenames follow the
   `YYYYMMDD_description.sql` convention, so a plain alphabetical sort is
   already date order.
3. Each applied file is recorded in `schema_migrations` so it never runs
   twice.
4. If nothing is pending, the server just logs that and continues starting
   normally — no-op, no errors.
5. If a migration fails, the server logs the full error and **exits**
   (`process.exit(1)`) rather than starting up against a half-migrated
   schema. Fix the migration file, then start the server again — it will
   retry only the failed one (and anything after it), not re-run migrations
   that already succeeded.

You'll see log lines like:
```
[migrations] Checking pending migrations...
[migrations] Applying migration: 20260801_add_new_column.sql
[migrations] Migration completed successfully.
```
or, when there's nothing to do:
```
[migrations] Checking pending migrations...
[migrations] No pending migrations found.
```

### First run: three possible starting points

The very first time the runner sees a database (its `schema_migrations`
tracking table doesn't exist yet), it distinguishes three cases before
deciding what to do:

1. **A completely empty database** — no `roles` table, meaning
   `database/schema.sql` has never been applied either. The runner applies
   `database/schema.sql` itself first (see `applySchemaBaseline()` in
   `src/database/migrationRunner.js`), then falls through to case 2 and runs
   every dated migration file for real. You'll see:
   ```
   [migrations] Empty database detected — applying database/schema.sql baseline.
   [migrations] Brand-new database detected — applying all NN migration(s) for real.
   ```
   This is the expected path for any new environment — no manual SQL of any
   kind is required first.
2. **A brand-new database that already has `database/schema.sql`'s tables**
   (applied by hand under the old flow, or just bootstrapped by case 1
   above) **but no `companies` table** — every dated migration file runs for
   real, in order, since schema.sql only ever defined the original baseline
   tables and everything since (companies, service categories, projects,
   entities, the RBAC redesign, etc.) lives exclusively in
   `database/migrations/*.sql`.
3. **An existing database that already has all of today's schema** (i.e.
   every migration file currently in the repo was already applied by hand,
   as was the case throughout this project's early development, discriminated
   by the `companies` table already existing) — it **baselines** instead of
   re-executing: every migration file present at that moment is recorded as
   already-applied without running its SQL, since the schema already
   reflects them. You'll see:
   ```
   [migrations] First run detected — baselining 16 existing migration(s) as already applied.
   ```
   Only migration files added **after** that point are ever actually
   executed. This avoids re-running old, non-idempotent `ALTER TABLE`/
   `INSERT` statements against a database that already has that change.

Case 3 is what keeps this change safe for every already-deployed
environment: nothing about their startup behavior changes, since their
`schema_migrations` table already exists (or their `companies` table already
does) by the time they upgrade to this runner.

### Adding a new migration

1. Create a new file in `database/migrations/`, named
   `YYYYMMDD_short_description.sql` (today's date, so it sorts after every
   existing file).
2. Write plain SQL — no special syntax required. If the change needs to be
   undone later, add a companion `YYYYMMDD_short_description_rollback.sql`
   (rollback files are never run automatically; that's a manual step if you
   ever need it).
3. Write it idempotently where practical (`IF NOT EXISTS`,
   `ON CONFLICT DO NOTHING`, `WHERE ... IS NULL` guards) — Postgres runs the
   whole file as one implicit transaction, so a failure partway through
   rolls the whole file back, but the safest migrations are also safe to
   re-run if needed.
4. That's it — the next time the server starts (in any environment: dev,
   staging, production), it picks up the new file automatically.

### Concurrent server instances

If more than one server instance starts at the same moment (e.g. a
multi-instance deploy), only one of them actually runs pending migrations —
the others wait on a Postgres advisory lock, then find everything already
applied and continue starting normally. No manual coordination needed.

Implementation: `src/database/migrationRunner.js`, wired into `server.js`.

---

## Resetting the Database (development only)

To wipe everything and start fresh:

```bash
psql -U rut_user -d rut_portal -c "
  DROP SCHEMA public CASCADE;
  CREATE SCHEMA public;
  GRANT ALL ON SCHEMA public TO rut_user;
"
```

Then just start the server again (`npm start` / `node server.js`) — the
migration runner detects the now-empty database and rebuilds the full
schema automatically (see [Automatic Migrations](#automatic-migrations)
above); no `psql -f database/schema.sql` step is needed. Follow with
`node scripts/seedPlatformAdmin.js <email> <password>` for a login, and
optionally `psql -f database/seeds.sql` / `psql -f database/rbac_seed.sql`
for demo data.

> Never run this against a production database.

---

## Table Overview

This lists the original baseline tables defined directly in
`database/schema.sql`. Every table added since (multi-tenancy: `companies`,
`entities`; RBAC redesign: `role_capabilities`, `role_migration_log`;
`projects`, `service_categories`, `employee_work_logs`,
`service_po_hierarchy`, `service_po_monthly_budgets`, and others) is defined
in `database/migrations/*.sql` instead — see that directory for the
authoritative, up-to-date full schema, or query `schema_migrations` /
`information_schema.tables` on a running database.

| Table | Description |
|-------|-------------|
| `roles` | User role definitions (HR, Finance, etc.) |
| `employees` | Employee master records |
| `users` | Auth accounts linked to employees |
| `clients` | Client / customer master |
| `service_types` | PO service categories |
| `service_pos` | Service Purchase Orders |
| `service_po_resources` | Employee–PO assignments |
| `sub_projects` | Sub-projects under a PO |
| `monthly_costs` | Per-employee monthly cost breakdown |
| `timesheets` | Daily hour logs per employee per PO |
| `audit_logs` | Full audit trail (JSONB old/new values) |
| `user_sessions` | Refresh-token store |
| `timesheet_import_history` | Bulk import job records |
| `timesheet_import_errors` | Row-level errors from bulk imports |
| `notifications` | In-app notifications per user |
| `user_roles` | Legacy many-to-many user↔role table (dropped by `20260840_collapse_user_roles.sql` — `users.role_id` is now the sole source of truth) |
| `form_master` | Sidebar/screen registry, keyed by (module, form) |
| `role_form_mapping` | Per-role form visibility (soft on/off via `status`) |
| `ai_insight_jobs` / `ai_insights` | AI Insights module configuration and generated insights |

---

## Notes

- All tables that track changes include `created_at`, `updated_at`, `created_by`, and `updated_by` columns.
- `updated_at` is maintained automatically by PostgreSQL triggers — no application-level logic needed.
- `audit_logs.old_values` and `audit_logs.new_values` are indexed with GIN for fast JSONB queries.
- `user_sessions` cascades deletes from `users` — removing a user clears all their sessions.
- `timesheet_import_errors` cascades deletes from `timesheet_import_history`.
