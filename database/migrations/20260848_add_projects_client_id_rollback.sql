-- Rollback for 20260848_add_projects_client_id.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.

BEGIN;

DROP INDEX IF EXISTS idx_projects_client_id;
ALTER TABLE projects DROP COLUMN IF EXISTS client_id;

COMMIT;
