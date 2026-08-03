-- =============================================================================
-- Multi-Tenancy Retrofit — Phase 1a: backfill company_id onto every existing
-- row, pointing at the default "GTT" company created in Phase 0. Idempotent
-- (WHERE company_id IS NULL guard on every statement) — safe to re-run.
-- Still leaves company_id NULLABLE; Phase 2 cuts over to NOT NULL once this
-- is verified complete.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  gtt_id INT;
BEGIN
  SELECT id INTO gtt_id FROM companies WHERE company_code = 'GTT';

  IF gtt_id IS NULL THEN
    RAISE EXCEPTION 'Default GTT company not found — run 20260728_add_company_tenancy_schema.sql first.';
  END IF;

  UPDATE users                    SET company_id = gtt_id WHERE company_id IS NULL;
  UPDATE clients                  SET company_id = gtt_id WHERE company_id IS NULL;
  UPDATE employees                SET company_id = gtt_id WHERE company_id IS NULL;
  UPDATE monthly_costs            SET company_id = gtt_id WHERE company_id IS NULL;
  UPDATE service_pos               SET company_id = gtt_id WHERE company_id IS NULL;
  UPDATE service_po_resources      SET company_id = gtt_id WHERE company_id IS NULL;
  UPDATE service_types             SET company_id = gtt_id WHERE company_id IS NULL;
  -- service_categories may not exist yet on a genuinely fresh database (see
  -- 20260803_ensure_service_categories_schema.sql's header) — this backfill
  -- is a no-op there anyway since 20260803 creates the table with company_id
  -- already populated, not NULL.
  IF to_regclass('public.service_categories') IS NOT NULL THEN
    UPDATE service_categories SET company_id = gtt_id WHERE company_id IS NULL;
  END IF;
  UPDATE sub_projects              SET company_id = gtt_id WHERE company_id IS NULL;
  UPDATE timesheets                SET company_id = gtt_id WHERE company_id IS NULL;
  UPDATE timesheet_import_history  SET company_id = gtt_id WHERE company_id IS NULL;
  UPDATE timesheet_import_errors   SET company_id = gtt_id WHERE company_id IS NULL;
  UPDATE ai_insights                SET company_id = gtt_id WHERE company_id IS NULL;
  UPDATE ai_insight_jobs            SET company_id = gtt_id WHERE company_id IS NULL;
END $$;

COMMIT;
