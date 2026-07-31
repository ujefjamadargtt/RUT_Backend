-- =============================================================================
-- Fix: employee_work_logs.timesheet_import_id was declared as a plain FK
-- with no ON DELETE action (defaults to NO ACTION/RESTRICT in Postgres),
-- so deleting a timesheet_import_history row blocked with:
--   "update or delete on table timesheet_import_history violates foreign
--    key constraint employee_work_logs_timesheet_import_id_fkey"
--
-- Business rule: Employee Work Logs are the source of truth and must
-- survive a Timesheet Import deletion — only the official Timesheet data
-- and its Import History should be removed. ON DELETE SET NULL makes this
-- a DB-level guarantee (not just an application convention): deleting an
-- import history row can never be blocked by, or cascade-delete, a work
-- log row again, regardless of which code path performs the delete.
--
-- This only clears the now-dangling FK column itself. The companion
-- application-level fix (timesheetService.js deleteImports ->
-- employeeWorkLogRepository.revertSyncStatusByImportIds) additionally
-- reverts status/synced_at back to 'pending'/null in the SAME transaction,
-- since a plain SET NULL would otherwise leave a row stuck at
-- status='synced' pointing at nothing.
--
-- Safe to re-run (DROP CONSTRAINT IF EXISTS + re-ADD).
-- =============================================================================

BEGIN;

ALTER TABLE employee_work_logs
  DROP CONSTRAINT IF EXISTS employee_work_logs_timesheet_import_id_fkey;

ALTER TABLE employee_work_logs
  ADD CONSTRAINT employee_work_logs_timesheet_import_id_fkey
  FOREIGN KEY (timesheet_import_id)
  REFERENCES timesheet_import_history (id)
  ON DELETE SET NULL;

COMMIT;
