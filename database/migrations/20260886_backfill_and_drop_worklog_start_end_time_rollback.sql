-- Rollback for 20260886_backfill_and_drop_worklog_start_end_time.sql
-- Run manually if this cutover needs to be undone.
--
-- Restores the columns and re-populates them ONLY for a work log that has
-- EXACTLY ONE time entry — that is the only case with an unambiguous single
-- pair to restore. A work log with multiple time entries (the whole point of
-- this feature) has no single pair to fall back to and is left NULL, exactly
-- as a plain hours-only row already is.

BEGIN;

ALTER TABLE employee_work_logs
  ADD COLUMN IF NOT EXISTS start_time TIME NULL,
  ADD COLUMN IF NOT EXISTS end_time TIME NULL;

ALTER TABLE employee_work_logs
  DROP CONSTRAINT IF EXISTS chk_employee_work_logs_start_end_time;
ALTER TABLE employee_work_logs
  ADD CONSTRAINT chk_employee_work_logs_start_end_time
  CHECK (start_time IS NULL OR end_time IS NULL OR end_time > start_time);

WITH single_entry_logs AS (
  SELECT employee_work_log_id
  FROM employee_work_log_time_entries
  GROUP BY employee_work_log_id
  HAVING COUNT(*) = 1
)
UPDATE employee_work_logs w
SET start_time = e.start_time, end_time = e.end_time
FROM employee_work_log_time_entries e
JOIN single_entry_logs s ON s.employee_work_log_id = e.employee_work_log_id
WHERE e.employee_work_log_id = w.id
  AND w.id = s.employee_work_log_id;

DELETE FROM schema_migrations WHERE name = '20260886_backfill_and_drop_worklog_start_end_time.sql';

COMMIT;
