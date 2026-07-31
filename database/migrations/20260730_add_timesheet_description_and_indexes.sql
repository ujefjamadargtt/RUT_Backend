-- =============================================================================
-- Employee Self Timesheet — Phase 3: a `description` column so Employee
-- self-service entries can carry a mandatory description (enforced at the
-- validation layer, not here — nullable at the DB level so existing
-- Admin/Excel-imported rows, which never had one, remain valid). Also adds
-- a composite index for the employee_id + date_range queries the Calendar/
-- Daily/Monthly APIs run. Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS description TEXT;

CREATE INDEX IF NOT EXISTS idx_timesheets_employee_date ON timesheets (employee_id, timesheet_date);

COMMIT;
