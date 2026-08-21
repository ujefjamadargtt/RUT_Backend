-- Rollback for 20260860_add_work_log_start_end_time.sql

BEGIN;

ALTER TABLE employee_work_logs
  DROP CONSTRAINT IF EXISTS chk_employee_work_logs_start_end_time;
ALTER TABLE employee_work_logs
  DROP COLUMN IF EXISTS start_time,
  DROP COLUMN IF EXISTS end_time;

COMMIT;
