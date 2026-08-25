-- Rollback for 20260881_add_employee_microsoft_object_id.sql
-- Not auto-run by the migration runner — apply manually if needed.

BEGIN;

DROP INDEX IF EXISTS uq_employees_microsoft_object_id;
ALTER TABLE employees DROP COLUMN IF EXISTS microsoft_object_id;

COMMIT;
