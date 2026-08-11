-- Rollback for 20260851_add_employee_timesheet_approval_required.sql
-- Not auto-run by the migration runner — apply manually if needed.

BEGIN;

ALTER TABLE employees DROP COLUMN IF EXISTS is_timesheet_approval_required;

COMMIT;
