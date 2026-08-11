-- =============================================================================
-- Service PO Monthly Budget Master — month-wise Invoice Amount / Billed Amount
-- (+ descriptions/remarks) maintained per Service PO by the Service PO
-- Manager. Consumed by GET /api/v1/reports/service-po-summary, which reads
-- invoice_amount/billed_amount from here instead of computing them from
-- timesheets/monthly_costs for the report's selected month/year.
--
-- One row per (service_po_id, month, year) — enforced by the unique
-- constraint below, which the service layer's upsert relies on.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS service_po_monthly_budgets (
  id SERIAL PRIMARY KEY,
  company_id INT REFERENCES companies (id),
  service_po_id INT NOT NULL REFERENCES service_pos (id),
  month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  year INT NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  invoice_amount DECIMAL(15, 2) NOT NULL DEFAULT 0 CHECK (invoice_amount >= 0),
  invoice_description TEXT,
  billed_amount DECIMAL(15, 2) NOT NULL DEFAULT 0 CHECK (billed_amount >= 0),
  billed_remark TEXT,
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_service_po_monthly_budgets_po_month_year
  ON service_po_monthly_budgets (service_po_id, month, year);
CREATE INDEX IF NOT EXISTS idx_service_po_monthly_budgets_service_po_id
  ON service_po_monthly_budgets (service_po_id);
CREATE INDEX IF NOT EXISTS idx_service_po_monthly_budgets_company_id
  ON service_po_monthly_budgets (company_id);
CREATE INDEX IF NOT EXISTS idx_service_po_monthly_budgets_month
  ON service_po_monthly_budgets (month);
CREATE INDEX IF NOT EXISTS idx_service_po_monthly_budgets_year
  ON service_po_monthly_budgets (year);

DROP TRIGGER IF EXISTS trg_service_po_monthly_budgets_updated_at ON service_po_monthly_budgets;
CREATE TRIGGER trg_service_po_monthly_budgets_updated_at BEFORE UPDATE ON service_po_monthly_budgets
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

COMMIT;
