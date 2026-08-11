-- Rollback for 20260812_add_service_pos_project_id.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.

BEGIN;

DROP INDEX IF EXISTS idx_service_pos_project_id;
ALTER TABLE service_pos DROP COLUMN IF EXISTS project_id;

COMMIT;
