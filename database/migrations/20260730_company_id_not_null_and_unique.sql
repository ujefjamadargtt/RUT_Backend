-- =============================================================================
-- Multi-Tenancy Retrofit — Phase 2: NOT NULL cutover + per-company uniqueness.
--
-- Sequencing safety: Phase 1's backfill already guarantees zero NULL
-- company_id rows on every business table (verified live before this file is
-- run). We still add a temporary DEFAULT alongside NOT NULL so any insert
-- path not yet updated by Phase 5 keeps working (defaults silently to GTT)
-- instead of erroring outright. That DEFAULT must be dropped explicitly
-- (ALTER COLUMN company_id DROP DEFAULT) before a second real company is
-- ever provisioned for real use — leaving it in place past that point would
-- silently misfile a second company's data into GTT. Track that drop as its
-- own go/no-go gate, not part of this file.
--
-- Constraint names below are the REAL, verified names from database/schema.sql
-- (some differ from what the Sequelize model files declare, and two tables —
-- employees, service_types, service_pos — turned out to already have a
-- DB-level constraint the initial code inventory missed by only reading the
-- model files instead of the schema directly).
-- =============================================================================

BEGIN;

DO $$
DECLARE
  gtt_id INT;
BEGIN
  SELECT id INTO gtt_id FROM companies WHERE company_code = 'GTT';

  EXECUTE format('ALTER TABLE users ALTER COLUMN company_id SET DEFAULT %L', gtt_id);
  -- users.company_id stays NULLABLE (the platform admin is the sole exception) — no SET NOT NULL here.

  EXECUTE format('ALTER TABLE clients ALTER COLUMN company_id SET DEFAULT %L', gtt_id);
  ALTER TABLE clients ALTER COLUMN company_id SET NOT NULL;

  EXECUTE format('ALTER TABLE employees ALTER COLUMN company_id SET DEFAULT %L', gtt_id);
  ALTER TABLE employees ALTER COLUMN company_id SET NOT NULL;

  EXECUTE format('ALTER TABLE monthly_costs ALTER COLUMN company_id SET DEFAULT %L', gtt_id);
  ALTER TABLE monthly_costs ALTER COLUMN company_id SET NOT NULL;

  EXECUTE format('ALTER TABLE service_pos ALTER COLUMN company_id SET DEFAULT %L', gtt_id);
  ALTER TABLE service_pos ALTER COLUMN company_id SET NOT NULL;

  EXECUTE format('ALTER TABLE service_po_resources ALTER COLUMN company_id SET DEFAULT %L', gtt_id);
  ALTER TABLE service_po_resources ALTER COLUMN company_id SET NOT NULL;

  EXECUTE format('ALTER TABLE service_types ALTER COLUMN company_id SET DEFAULT %L', gtt_id);
  ALTER TABLE service_types ALTER COLUMN company_id SET NOT NULL;

  -- service_categories may not exist yet on a genuinely fresh database (see
  -- 20260803_ensure_service_categories_schema.sql's header) — skip gracefully
  -- there; that later migration creates it with company_id already NOT NULL.
  IF to_regclass('public.service_categories') IS NOT NULL THEN
    EXECUTE format('ALTER TABLE service_categories ALTER COLUMN company_id SET DEFAULT %L', gtt_id);
    ALTER TABLE service_categories ALTER COLUMN company_id SET NOT NULL;
  END IF;

  EXECUTE format('ALTER TABLE sub_projects ALTER COLUMN company_id SET DEFAULT %L', gtt_id);
  ALTER TABLE sub_projects ALTER COLUMN company_id SET NOT NULL;

  EXECUTE format('ALTER TABLE timesheets ALTER COLUMN company_id SET DEFAULT %L', gtt_id);
  ALTER TABLE timesheets ALTER COLUMN company_id SET NOT NULL;

  EXECUTE format('ALTER TABLE timesheet_import_history ALTER COLUMN company_id SET DEFAULT %L', gtt_id);
  ALTER TABLE timesheet_import_history ALTER COLUMN company_id SET NOT NULL;

  EXECUTE format('ALTER TABLE timesheet_import_errors ALTER COLUMN company_id SET DEFAULT %L', gtt_id);
  ALTER TABLE timesheet_import_errors ALTER COLUMN company_id SET NOT NULL;

  EXECUTE format('ALTER TABLE ai_insights ALTER COLUMN company_id SET DEFAULT %L', gtt_id);
  ALTER TABLE ai_insights ALTER COLUMN company_id SET NOT NULL;

  EXECUTE format('ALTER TABLE ai_insight_jobs ALTER COLUMN company_id SET DEFAULT %L', gtt_id);
  ALTER TABLE ai_insight_jobs ALTER COLUMN company_id SET NOT NULL;
END $$;

-- Per-company uniqueness: drop the old single-column constraint, add the
-- composite (company_id, code) one. Real constraint names verified against
-- database/schema.sql.
ALTER TABLE clients DROP CONSTRAINT IF EXISTS uq_clients_client_code;
ALTER TABLE clients ADD CONSTRAINT uq_clients_company_code UNIQUE (company_id, client_code);

ALTER TABLE employees DROP CONSTRAINT IF EXISTS uq_employees_employee_code;
ALTER TABLE employees ADD CONSTRAINT uq_employees_company_code UNIQUE (company_id, employee_code);

ALTER TABLE service_types DROP CONSTRAINT IF EXISTS uq_service_types_name;
ALTER TABLE service_types ADD CONSTRAINT uq_service_types_company_name UNIQUE (company_id, service_type_name);

ALTER TABLE service_pos DROP CONSTRAINT IF EXISTS uq_service_pos_code;
ALTER TABLE service_pos ADD CONSTRAINT uq_service_pos_company_code UNIQUE (company_id, service_po_code);

ALTER TABLE sub_projects DROP CONSTRAINT IF EXISTS uq_sub_projects_code;
ALTER TABLE sub_projects ADD CONSTRAINT uq_sub_projects_company_code UNIQUE (company_id, sub_project_code);

-- service_categories.name had no prior DB-level constraint (app-layer check
-- only) — add the composite one fresh. IF EXISTS on the table: may not exist
-- yet on a genuinely fresh database (see
-- 20260803_ensure_service_categories_schema.sql's header), which applies
-- this same constraint unconditionally once it creates the table.
ALTER TABLE IF EXISTS service_categories DROP CONSTRAINT IF EXISTS uq_service_categories_company_name;
ALTER TABLE IF EXISTS service_categories ADD CONSTRAINT uq_service_categories_company_name UNIQUE (company_id, name);

-- users.email intentionally left untouched — stays globally unique (login identity).

COMMIT;
