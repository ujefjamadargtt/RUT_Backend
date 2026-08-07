-- =============================================================================
-- Monthly Work Log support for employee_work_logs.
--
-- Employees could previously only log hours day-by-day (Daily Work Log).
-- This adds a second mode, Monthly Work Log, where an employee submits one
-- month's hours in a single go, stored as row(s) dated on the month's LAST
-- calendar day (see employeeMonthlyWorkLogService.js). Both modes share this
-- same table — log_type distinguishes them.
--
-- hours is widened from NUMERIC(4,2) (max 99.99) to NUMERIC(6,2) (max
-- 9999.99) so a monthly line item can hold up to the 176-hour monthly cap;
-- Daily rows (still capped at 12 at the application layer) are unaffected.
--
-- No change to uq_employee_work_logs (employee_id, service_po_id,
-- COALESCE(hierarchy_node_id, 0), work_date) — Monthly submit deletes every
-- row (any log_type) in the month's date range before inserting, so nothing
-- from before that call can ever collide with what's being inserted.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE employee_work_logs ADD COLUMN IF NOT EXISTS log_type VARCHAR(10) NOT NULL DEFAULT 'daily';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_employee_work_logs_log_type'
  ) THEN
    ALTER TABLE employee_work_logs
      ADD CONSTRAINT chk_employee_work_logs_log_type CHECK (log_type IN ('daily', 'monthly'));
  END IF;
END $$;

ALTER TABLE employee_work_logs ALTER COLUMN hours TYPE NUMERIC(6, 2);

-- The original table migration's `hours > 0 AND hours <= 12` CHECK is a
-- hard DB-level cap that would reject any Monthly row above 12 hours
-- regardless of the widened column precision above. Replace it with a
-- log_type-aware version: 12 for 'daily' (unchanged), 176 for 'monthly'.
ALTER TABLE employee_work_logs DROP CONSTRAINT IF EXISTS employee_work_logs_hours_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_employee_work_logs_hours_by_log_type'
  ) THEN
    ALTER TABLE employee_work_logs
      ADD CONSTRAINT chk_employee_work_logs_hours_by_log_type CHECK (
        hours > 0 AND (
          (log_type = 'daily' AND hours <= 12) OR
          (log_type = 'monthly' AND hours <= 176)
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_employee_work_logs_log_type
  ON employee_work_logs (employee_id, log_type, work_date);

COMMIT;
