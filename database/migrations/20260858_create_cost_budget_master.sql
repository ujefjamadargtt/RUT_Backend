-- =============================================================================
-- Cost Budget Master — month-wise Invoice Amount (+ description) maintained
-- per Service PO. New, isolated master table; independent of the existing
-- service_po_monthly_budgets table (which already tracks invoice_amount/
-- billed_amount per Service PO + month, but is kept unchanged here per the
-- isolation requirement of this feature).
--
-- One row per (service_po_id, month, year) regardless of status — enforced
-- by the unique constraint below. Deactivating a record (status='inactive')
-- does not free up the (service_po_id, month, year) key for a new row,
-- matching the manager_servicepo_mappings / employee_servicepo_mapping
-- soft-delete convention already used in this project.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS cost_budget_master (
  id SERIAL PRIMARY KEY,
  company_id INT REFERENCES companies (id),
  service_po_id INT NOT NULL REFERENCES service_pos (id),
  month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  year INT NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  invoice_amount DECIMAL(15, 2) NOT NULL DEFAULT 0 CHECK (invoice_amount >= 0),
  description TEXT,
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cost_budget_master_po_month_year
  ON cost_budget_master (service_po_id, month, year);
CREATE INDEX IF NOT EXISTS idx_cost_budget_master_service_po_id
  ON cost_budget_master (service_po_id);
CREATE INDEX IF NOT EXISTS idx_cost_budget_master_company_id
  ON cost_budget_master (company_id);
CREATE INDEX IF NOT EXISTS idx_cost_budget_master_month_year
  ON cost_budget_master (month, year);

DROP TRIGGER IF EXISTS trg_cost_budget_master_updated_at ON cost_budget_master;
CREATE TRIGGER trg_cost_budget_master_updated_at BEFORE UPDATE ON cost_budget_master
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

COMMIT;
