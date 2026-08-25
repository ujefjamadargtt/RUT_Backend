-- Rollback for 20260864_add_employee_login_columns.sql
-- Not auto-run by the migration runner — apply manually if needed.

BEGIN;

DROP INDEX IF EXISTS uq_employees_email;
ALTER TABLE employees DROP COLUMN IF EXISTS email;
ALTER TABLE employees DROP COLUMN IF EXISTS password;

COMMIT;
