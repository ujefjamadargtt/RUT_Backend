-- =============================================================================
-- Employee Work Log — add 'approved' status, between 'pending' and 'synced'.
--
-- The approval flow now happens BEFORE Sync, not after: a Manager approves
-- an Employee's pending Work Log entries directly; only once approved (or
-- immediately, for an Employee whose is_timesheet_approval_required is
-- false) can Sync ever pick a row up and turn it into an official
-- `timesheets` row. There was previously no status value representing
-- "Manager approved, not yet synced" — this migration adds it.
--
-- status: 'pending'  -> entered by employee, awaiting approval (or Sync,
--                        if approval isn't required for this employee).
--         'approved'  -> approved (by a Manager, or automatically because
--                        approval isn't required for this employee) but
--                        Sync has not run yet. Eligible for Sync.
--         'synced'    -> included in a completed sync; the corresponding
--                        official record now lives in `timesheets`.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE employee_work_logs DROP CONSTRAINT IF EXISTS employee_work_logs_status_check;

ALTER TABLE employee_work_logs
  ADD CONSTRAINT employee_work_logs_status_check
  CHECK (status IN ('pending', 'approved', 'synced'));

COMMIT;
