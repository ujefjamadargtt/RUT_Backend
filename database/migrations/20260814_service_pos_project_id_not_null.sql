-- =============================================================================
-- Phase 3 of 3 for service_pos.project_id — cut over to NOT NULL now that
-- every existing row has been backfilled (20260813). Every Service PO must
-- belong to exactly one Project from this point forward.
--
-- Guarded: only runs the ALTER once every row already has a project_id, so
-- this is safe to re-run and safe if applied out of order relative to a
-- delayed 20260813 in some environment.
-- =============================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM service_pos WHERE project_id IS NULL) THEN
    ALTER TABLE service_pos ALTER COLUMN project_id SET NOT NULL;
  ELSE
    RAISE EXCEPTION 'service_pos still has rows with a NULL project_id — run 20260813_backfill_service_pos_project_id.sql first.';
  END IF;
END $$;

COMMIT;
