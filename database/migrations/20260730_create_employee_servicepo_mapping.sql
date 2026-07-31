-- =============================================================================
-- Employee Self Timesheet — Phase 2: which Service POs an Employee is
-- allowed to self-log time against. Distinct from the existing
-- service_po_resources allocation table (no status lifecycle there) — this
-- table drives Project Loading + eligibility checks in the Employee
-- Timesheet module (Phase 3). Safe to re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS employee_servicepo_mapping (
  id SERIAL PRIMARY KEY,
  company_id INT REFERENCES companies(id),
  employee_id INT NOT NULL REFERENCES employees(id),
  service_po_id INT NOT NULL REFERENCES service_pos(id),
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_employee_servicepo_mapping UNIQUE (employee_id, service_po_id)
);

CREATE INDEX IF NOT EXISTS idx_employee_servicepo_mapping_company_id     ON employee_servicepo_mapping (company_id);
CREATE INDEX IF NOT EXISTS idx_employee_servicepo_mapping_employee_id    ON employee_servicepo_mapping (employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_servicepo_mapping_service_po_id  ON employee_servicepo_mapping (service_po_id);
CREATE INDEX IF NOT EXISTS idx_employee_servicepo_mapping_status         ON employee_servicepo_mapping (status);

DROP TRIGGER IF EXISTS trg_employee_servicepo_mapping_updated_at ON employee_servicepo_mapping;
CREATE TRIGGER trg_employee_servicepo_mapping_updated_at BEFORE UPDATE ON employee_servicepo_mapping
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

COMMIT;
