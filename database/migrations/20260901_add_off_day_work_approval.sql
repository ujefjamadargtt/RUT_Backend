-- Off-Day Approval Gate — per-BU weekend policy plus a Project Manager
-- approval gate before an Employee can log hours on a day their BU marks
-- as off (see the "Off-Day Approval Gate" proposal, 2026-09-18).
--
-- companies.saturday_off_rule: only Saturday actually varies BU to BU —
-- every known pattern keeps Sunday off, so Sunday stays an implicit
-- platform rule (see src/utils/weekOffPolicy.js) rather than its own
-- column.
--   ALL     - every Saturday off (+ every Sunday)
--   ALT_1_3 - 1st & 3rd Saturday off (+ every Sunday)
--   ALT_2_4 - 2nd & 4th Saturday off (+ every Sunday)
--   NONE    - no Saturdays off (+ every Sunday)
-- Defaulted to 'ALL' for every existing BU on backfill — the strictest/
-- most common pattern; BU Admins correct the ones that actually run
-- 1st/3rd or 2nd/4th Saturday shifts.
--
-- off_day_work_requests: one row per (employee, service PO, date) an
-- Employee has ever asked to work an off day for. Resubmitting a rejected
-- request flips the SAME row back to 'pending' (never a new row) — the
-- same shape as employee_work_logs' own reject/resubmit lifecycle (see
-- EmployeeWorkLog.js's status doc comment).
--
-- Safe to re-run.

BEGIN;

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS saturday_off_rule VARCHAR(10) NOT NULL DEFAULT 'ALL';

ALTER TABLE companies DROP CONSTRAINT IF EXISTS chk_companies_saturday_off_rule;
ALTER TABLE companies
  ADD CONSTRAINT chk_companies_saturday_off_rule
  CHECK (saturday_off_rule IN ('ALL', 'ALT_1_3', 'ALT_2_4', 'NONE'));

CREATE TABLE IF NOT EXISTS off_day_work_requests (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  company_id INTEGER REFERENCES companies(id),
  service_po_id INTEGER NOT NULL REFERENCES service_pos(id),
  work_date DATE NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status VARCHAR(10) NOT NULL DEFAULT 'pending',
  decided_by INTEGER REFERENCES employees(id),
  decided_at TIMESTAMPTZ,
  decision_remark TEXT,
  created_by INTEGER,
  updated_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_off_day_work_requests_status CHECK (status IN ('pending', 'approved', 'rejected'))
);

-- One row per (employee, service PO, date) ever — a rejected request is
-- resubmitted by flipping this SAME row back to 'pending', never inserting
-- a second one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_off_day_work_requests_employee_po_date
  ON off_day_work_requests (employee_id, service_po_id, work_date);

CREATE INDEX IF NOT EXISTS idx_off_day_work_requests_status
  ON off_day_work_requests (status);

COMMIT;
