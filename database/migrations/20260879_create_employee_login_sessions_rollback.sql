-- Rollback for 20260879_create_employee_login_sessions.sql
-- Not auto-run by the migration runner — apply manually if needed.

BEGIN;

DROP TRIGGER IF EXISTS trg_employee_login_sessions_updated_at ON employee_login_sessions;
DROP TABLE IF EXISTS employee_login_sessions;

COMMIT;
