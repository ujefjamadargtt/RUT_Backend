-- Migration: add admin-adjustable "Modified Hours" + publish flags.
--
-- timesheets.modified_hours — the admin-editable effective hours value.
--   hours_logged (the original, imported/entered value) is NEVER modified by
--   this feature; modified_hours starts out equal to hours_logged at insert
--   time (set in application code, not a DB default/trigger — see
--   timesheetService.js's createTimesheet()/confirmImport()) and is only
--   ever changed via PATCH /timesheets/:id/modified-hours.
-- timesheets.is_publish — set true the first time modified_hours is edited
--   for that row via the dedicated endpoint. One-way flag: never reset to
--   false anywhere in this feature.
-- timesheet_import_history.is_publish — set true on the parent "monthly
--   sheet" the first time any of its child rows gets a modified_hours edit.
--
-- Same precision/scale as hours_logged (DECIMAL(5,2), 0-999.99) — see
-- database/migrations/20260626_remove_hours_upper_bound.sql for why
-- hours_logged itself is (5,2).
--
-- To apply:
-- psql -U <db_user> -d <database> -f database/migrations/20260722_add_modified_hours_and_is_publish.sql

BEGIN;

ALTER TABLE IF EXISTS timesheets
  ADD COLUMN IF NOT EXISTS modified_hours DECIMAL(5,2) NULL;

ALTER TABLE IF EXISTS timesheets
  ADD CONSTRAINT chk_timesheets_modified_hours CHECK (modified_hours IS NULL OR modified_hours >= 0);

ALTER TABLE IF EXISTS timesheets
  ADD COLUMN IF NOT EXISTS is_publish BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE IF EXISTS timesheet_import_history
  ADD COLUMN IF NOT EXISTS is_publish BOOLEAN NOT NULL DEFAULT false;

COMMIT;
