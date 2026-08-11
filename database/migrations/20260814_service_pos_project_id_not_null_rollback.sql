-- Rollback for 20260814_service_pos_project_id_not_null.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.

BEGIN;

ALTER TABLE service_pos ALTER COLUMN project_id DROP NOT NULL;

COMMIT;
