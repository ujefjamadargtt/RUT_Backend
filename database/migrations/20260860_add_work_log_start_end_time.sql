-- =============================================================================
-- Employee Work Log — start_time / end_time. Additive only: the existing
-- `hours` column is untouched and remains the source of truth for every
-- historical row (which has NULL start_time/end_time). New time-based
-- entries have both start_time and end_time set, and the application layer
-- (employeeTimesheetService.js) always recalculates `hours` from them
-- server-side rather than trusting a caller-supplied value.
--
-- work_date already represents the date, so start_time/end_time are plain
-- TIME (no date component) — a time-of-day within that same work_date.
--
-- The CHECK below is a defense-in-depth backstop mirroring the application
-- layer's "end_time must be later than start_time" rule; either column
-- being NULL (an old row, or a non-time-based entry) always passes.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE employee_work_logs
  ADD COLUMN IF NOT EXISTS start_time TIME NULL,
  ADD COLUMN IF NOT EXISTS end_time TIME NULL;

ALTER TABLE employee_work_logs
  DROP CONSTRAINT IF EXISTS chk_employee_work_logs_start_end_time;
ALTER TABLE employee_work_logs
  ADD CONSTRAINT chk_employee_work_logs_start_end_time
  CHECK (start_time IS NULL OR end_time IS NULL OR end_time > start_time);

COMMIT;
