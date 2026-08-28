-- Add a per-slot description to employee_work_log_time_entries.
--
-- Until now every Start Time/End Time segment under one employee_work_logs
-- row shared that row's single `description` — fine while a Module/Task
-- only ever had one segment per date, but the Time Entry form allows
-- several disjoint segments (see employee_work_log_time_entries, created by
-- 20260885_create_employee_work_log_time_entries.sql) and each one now
-- needs its own text (e.g. "API development" for 09:00-10:00 vs
-- "Bug fixing" for 11:00-12:30 against the SAME Module/Task/date).
--
-- The parent row's own `description` column is untouched and remains
-- required/authoritative for the Module/Task as a whole (Sync, reports,
-- and every pre-existing consumer keep reading it exactly as before) — this
-- is purely additive, finer-grained detail alongside it.

-- 1. Add as nullable first so the column can be backfilled before the
--    NOT NULL constraint is applied — adding it NOT NULL directly would
--    fail against any existing rows.
ALTER TABLE employee_work_log_time_entries
  ADD COLUMN IF NOT EXISTS description TEXT;

-- 2. Backfill every pre-existing segment from its parent row's description,
--    so no historical slot is left without one.
UPDATE employee_work_log_time_entries AS te
SET description = wl.description
FROM employee_work_logs AS wl
WHERE te.employee_work_log_id = wl.id
  AND te.description IS NULL;

-- 3. A handful of legacy parent rows could theoretically have an empty
--    description if a prior data fix ever slipped one through; guard
--    against a NOT NULL failure on those rather than blocking the whole
--    migration.
UPDATE employee_work_log_time_entries
SET description = 'Migrated time entry'
WHERE description IS NULL OR btrim(description) = '';

-- 4. Now safe to enforce NOT NULL going forward — every new segment must
--    supply its own description (see employeeTimesheetValidation.timeEntrySchema).
ALTER TABLE employee_work_log_time_entries
  ALTER COLUMN description SET NOT NULL;
