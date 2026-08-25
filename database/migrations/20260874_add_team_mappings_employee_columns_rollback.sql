-- Rollback for 20260874_add_team_mappings_employee_columns.sql
-- Not auto-run by the migration runner — apply manually if needed.

BEGIN;

ALTER TABLE team_mappings DROP COLUMN IF EXISTS manager_employee_id;
ALTER TABLE team_mappings DROP COLUMN IF EXISTS service_po_admin_employee_id;

COMMIT;
