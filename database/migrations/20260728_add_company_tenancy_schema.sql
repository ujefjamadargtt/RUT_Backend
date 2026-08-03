-- =============================================================================
-- Multi-Tenancy Retrofit — Phase 0: additive schema only, zero behavior change.
-- Creates the companies table, seeds a default "GTT" company, and adds a
-- nullable company_id column (+ users.is_platform_admin) to every table that
-- will become company-scoped. Nothing in the application reads these columns
-- yet — this migration is a no-op from the running app's perspective.
-- Safe to re-run (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS throughout).
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  company_code VARCHAR(20) NOT NULL,
  company_name VARCHAR(150) NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  is_deleted BOOLEAN NOT NULL DEFAULT false,
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_companies_company_code UNIQUE (company_code)
);
CREATE INDEX IF NOT EXISTS idx_companies_status ON companies (status);
DROP TRIGGER IF EXISTS trg_companies_updated_at ON companies;
CREATE TRIGGER trg_companies_updated_at BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- Default tenant every pre-existing row will be backfilled onto in Phase 1.
INSERT INTO companies (company_code, company_name)
VALUES ('GTT', 'GTT (Default Company)')
ON CONFLICT (company_code) DO NOTHING;

-- Platform-level flag on users — Super Admin is the one row with company_id
-- NULL and this set true; every other user belongs to exactly one company.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN NOT NULL DEFAULT false;

-- Nullable company_id on every company-owned table. Left nullable here on
-- purpose — Phase 1 backfills every existing row, Phase 2 then cuts over to
-- NOT NULL once backfill is verified complete. form_master, roles,
-- role_form_mapping, notifications, and user_sessions intentionally do NOT
-- get this column (global catalog / role definitions / transitively scoped
-- via user_id — see the retrofit plan).
ALTER TABLE users                      ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies (id);
ALTER TABLE clients                    ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies (id);
ALTER TABLE employees                  ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies (id);
ALTER TABLE monthly_costs              ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies (id);
ALTER TABLE service_pos                ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies (id);
ALTER TABLE service_po_resources       ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies (id);
ALTER TABLE service_types              ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies (id);
-- service_categories specifically uses IF EXISTS here (unlike every other
-- line below) because, unlike the rest of these tables, it was never
-- actually created by database/schema.sql or any migration before this one —
-- it only ever existed on databases where it had been added out-of-band
-- (see 20260803_ensure_service_categories_schema.sql's header for the full
-- story). On a database that genuinely doesn't have it yet, this becomes a
-- safe no-op; 20260803_ensure_service_categories_schema.sql (which runs
-- later in filename order) creates the table AND applies this same
-- company_id retrofit to it unconditionally, so nothing is lost.
ALTER TABLE IF EXISTS service_categories ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies (id);
ALTER TABLE sub_projects               ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies (id);
ALTER TABLE timesheets                 ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies (id);
ALTER TABLE timesheet_import_history   ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies (id);
ALTER TABLE timesheet_import_errors    ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies (id);
ALTER TABLE ai_insights                ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies (id);
ALTER TABLE ai_insight_jobs            ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies (id);

CREATE INDEX IF NOT EXISTS idx_users_company_id                    ON users (company_id);
CREATE INDEX IF NOT EXISTS idx_clients_company_id                  ON clients (company_id);
CREATE INDEX IF NOT EXISTS idx_employees_company_id                ON employees (company_id);
CREATE INDEX IF NOT EXISTS idx_monthly_costs_company_id            ON monthly_costs (company_id);
CREATE INDEX IF NOT EXISTS idx_service_pos_company_id              ON service_pos (company_id);
CREATE INDEX IF NOT EXISTS idx_service_po_resources_company_id     ON service_po_resources (company_id);
CREATE INDEX IF NOT EXISTS idx_service_types_company_id            ON service_types (company_id);
-- CREATE INDEX has no "IF EXISTS <table>" form, so this one is guarded with
-- a DO block instead (DDL inside PL/pgSQL requires EXECUTE) — same reasoning
-- as the ALTER TABLE above.
DO $$ BEGIN
  IF to_regclass('public.service_categories') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_service_categories_company_id ON service_categories (company_id)';
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_sub_projects_company_id             ON sub_projects (company_id);
CREATE INDEX IF NOT EXISTS idx_timesheets_company_id               ON timesheets (company_id);
CREATE INDEX IF NOT EXISTS idx_timesheet_import_history_company_id ON timesheet_import_history (company_id);
CREATE INDEX IF NOT EXISTS idx_timesheet_import_errors_company_id  ON timesheet_import_errors (company_id);
CREATE INDEX IF NOT EXISTS idx_ai_insights_company_id              ON ai_insights (company_id);
CREATE INDEX IF NOT EXISTS idx_ai_insight_jobs_company_id          ON ai_insight_jobs (company_id);

COMMIT;
