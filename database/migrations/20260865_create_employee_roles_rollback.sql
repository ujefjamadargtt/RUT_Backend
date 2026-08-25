-- Rollback for 20260865_create_employee_roles.sql
-- Not auto-run by the migration runner — apply manually if needed.

BEGIN;

DROP TRIGGER IF EXISTS trg_employee_roles_updated_at ON employee_roles;
DROP TABLE IF EXISTS employee_roles;

COMMIT;
