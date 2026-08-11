-- =============================================================================
-- Employee-level Timesheet Approval Configuration.
--
-- Generalizes the existing is_publish policy (see src/utils/
-- timesheetPublishPolicy.js) from company-wide to employee-level. Before
-- this migration, whether a NEW timesheet row started is_publish=false
-- ("held back", someone must later explicitly Publish) or is_publish=true
-- (auto-published immediately) was decided ENTIRELY by
-- companies.is_original_data_visible — every employee in a company shared
-- the same behavior. This column makes that decision per-employee instead.
--
-- true  -> this employee's new timesheets start is_publish=false; someone
--          must later explicitly Publish them (the existing, untouched
--          Publish flow — see timesheetService.js's publishImport()).
-- false -> this employee's new timesheets are published immediately.
--
-- companies.is_original_data_visible is UNCHANGED and keeps its own,
-- separate job (a login-response UI hint in authService.js) — it is no
-- longer consulted for the is_publish decision itself after this migration.
--
-- Backfill preserves every EXISTING employee's current effective behavior
-- exactly, mirroring their company's is_original_data_visible at the time
-- of this migration, so no existing employee's timesheet behavior silently
-- changes. New employees created after this migration default to true
-- (require approval) unless the caller explicitly opts out.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS is_timesheet_approval_required BOOLEAN NOT NULL DEFAULT true;

UPDATE employees e
SET is_timesheet_approval_required = COALESCE(c.is_original_data_visible, false)
FROM companies c
WHERE e.company_id = c.id;

COMMIT;
