-- =============================================================================
-- Employee Work Log — retire the single start_time/end_time pair on
-- employee_work_logs now that employee_work_log_time_entries (see
-- 20260885_create_employee_work_log_time_entries.sql) is the source of
-- truth for Start Time/End Time. That table's write path
-- (employeeTimesheetService.js) has already stopped populating these two
-- columns going forward; this migration is the one-time cutover for every
-- row created BEFORE that change.
--
-- Step 1: backfill. Every employee_work_logs row that still has a non-null
-- start_time/end_time pair (created under the old single-pair feature)
-- becomes exactly one row in employee_work_log_time_entries — no historical
-- Start Time/End Time data is lost. Rows with no time pair at all
-- (plain hours-only entries, the vast majority) have nothing to backfill.
--
-- Step 2: drop. Once every row's time data lives in the new table, the old
-- columns (and their CHECK constraint) are dropped from employee_work_logs —
-- per this feature's requirement that the detailed table become the sole
-- place Start Time/End Time is stored; employee_work_logs.hours remains the
-- aggregated total, unaffected.
--
-- Safe to re-run: the backfill INSERT is naturally a no-op on a second run
-- (the columns it reads no longer exist after Step 2 completes), and every
-- DDL statement uses IF EXISTS.
-- =============================================================================

BEGIN;

INSERT INTO employee_work_log_time_entries
  (employee_work_log_id, entry_date, start_time, end_time, duration_hours, created_by, updated_by, created_at, updated_at)
SELECT
  id,
  work_date,
  start_time,
  end_time,
  ROUND((EXTRACT(EPOCH FROM (end_time - start_time)) / 3600)::NUMERIC, 2),
  created_by,
  updated_by,
  created_at,
  updated_at
FROM employee_work_logs
WHERE start_time IS NOT NULL
  AND end_time IS NOT NULL;

ALTER TABLE employee_work_logs DROP CONSTRAINT IF EXISTS chk_employee_work_logs_start_end_time;
ALTER TABLE employee_work_logs DROP COLUMN IF EXISTS start_time;
ALTER TABLE employee_work_logs DROP COLUMN IF EXISTS end_time;

COMMIT;
