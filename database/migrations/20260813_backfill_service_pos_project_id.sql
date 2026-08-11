-- =============================================================================
-- Phase 2 of 3 for service_pos.project_id — backfill.
--
-- Every company gets exactly one auto-created "Default Project"
-- (project_code 'PRJ-DEFAULT-<company_id>', idempotent via
-- ON CONFLICT DO NOTHING on uq_projects_company_code), and every one of
-- that company's existing Service POs with project_id still NULL is
-- assigned to it. New Service POs created after this must pick a real
-- Project via the normal API — this default only exists to satisfy the
-- upcoming NOT NULL constraint (20260814) for pre-existing rows.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  comp RECORD;
  default_project_id INT;
  fallback_user INT;
BEGIN
  FOR comp IN SELECT id FROM companies WHERE is_deleted = false LOOP
    -- created_by/updated_by are nullable — best-effort attribute to any user
    -- of this company, never blocks the insert if none is found (same
    -- pattern as 20260804_backfill_default_service_types.sql).
    SELECT id INTO fallback_user FROM users WHERE company_id = comp.id ORDER BY id LIMIT 1;

    INSERT INTO projects (company_id, project_code, project_name, project_description, status, created_by, updated_by, created_at, updated_at)
    VALUES (
      comp.id,
      'PRJ-DEFAULT-' || comp.id,
      'Default Project',
      'Auto-created during Project Master rollout to hold Service POs that existed before Projects were introduced.',
      'active',
      fallback_user,
      fallback_user,
      NOW(),
      NOW()
    )
    ON CONFLICT (company_id, project_code) DO NOTHING;

    SELECT id INTO default_project_id
      FROM projects
      WHERE company_id = comp.id AND project_code = 'PRJ-DEFAULT-' || comp.id
      LIMIT 1;

    UPDATE service_pos
      SET project_id = default_project_id
      WHERE company_id = comp.id AND project_id IS NULL;
  END LOOP;
END $$;

COMMIT;
