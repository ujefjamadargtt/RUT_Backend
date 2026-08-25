-- Rollback for 20260872_add_manager_employee_mappings_manager_employee_id.sql
-- Not auto-run by the migration runner — apply manually if needed.

BEGIN;

ALTER TABLE manager_employee_mappings DROP COLUMN IF EXISTS manager_employee_id;

COMMIT;
