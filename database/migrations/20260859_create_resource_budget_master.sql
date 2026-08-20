-- =============================================================================
-- Resource Budget Master — planned monthly hours per Employee + Service PO.
-- New, isolated master table. Feeds the 176-hour-per-employee-per-month
-- validation enforced in resourceBudgetService.js (SUM(hours) across every
-- active Service PO for one employee + month must never exceed 176).
--
-- One row per (emp_id, service_po_id, month, year) regardless of status —
-- enforced by the unique constraint below, same soft-delete convention as
-- cost_budget_master / manager_servicepo_mappings / employee_servicepo_mapping.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS resource_budget_master (
  id SERIAL PRIMARY KEY,
  company_id INT REFERENCES companies (id),
  emp_id INT NOT NULL REFERENCES employees (id),
  service_po_id INT NOT NULL REFERENCES service_pos (id),
  month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  year INT NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  hours DECIMAL(6, 2) NOT NULL DEFAULT 0 CHECK (hours >= 0),
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_resource_budget_master_emp_po_month_year
  ON resource_budget_master (emp_id, service_po_id, month, year);
CREATE INDEX IF NOT EXISTS idx_resource_budget_master_emp_id
  ON resource_budget_master (emp_id);
CREATE INDEX IF NOT EXISTS idx_resource_budget_master_service_po_id
  ON resource_budget_master (service_po_id);
CREATE INDEX IF NOT EXISTS idx_resource_budget_master_company_id
  ON resource_budget_master (company_id);
-- Speeds up the 176-hour validation, which sums hours across every Service
-- PO for one employee + month.
CREATE INDEX IF NOT EXISTS idx_resource_budget_master_emp_month_year
  ON resource_budget_master (emp_id, month, year);

DROP TRIGGER IF EXISTS trg_resource_budget_master_updated_at ON resource_budget_master;
CREATE TRIGGER trg_resource_budget_master_updated_at BEFORE UPDATE ON resource_budget_master
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

COMMIT;
