-- Rollback for 20260810_add_monthly_work_log_support.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.

BEGIN;

DROP INDEX IF EXISTS idx_employee_work_logs_log_type;

ALTER TABLE employee_work_logs DROP CONSTRAINT IF EXISTS chk_employee_work_logs_hours_by_log_type;

ALTER TABLE employee_work_logs ALTER COLUMN hours TYPE NUMERIC(4, 2);

ALTER TABLE employee_work_logs ADD CONSTRAINT employee_work_logs_hours_check CHECK (hours > 0 AND hours <= 12);

ALTER TABLE employee_work_logs DROP CONSTRAINT IF EXISTS chk_employee_work_logs_log_type;

ALTER TABLE employee_work_logs DROP COLUMN IF EXISTS log_type;

COMMIT;
