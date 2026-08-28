-- Rollback for 20260887_add_time_entry_description.sql
-- Run manually if needed — the migration runner never picks this up
-- automatically (see migrationRunner.js's *_rollback.sql exclusion).

ALTER TABLE employee_work_log_time_entries
  DROP COLUMN IF EXISTS description;
