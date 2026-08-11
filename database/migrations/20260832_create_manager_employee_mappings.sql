-- =============================================================================
-- Manager Employee Mapping — a Head Manager's grant of an Employee to one
-- of their own Managers. An Employee belongs to EXACTLY ONE Manager at a
-- time — enforced with a unique index on employee_id ALONE (same pattern
-- as head_manager_mappings' manager_user_id uniqueness).
--
-- No pre-existing Employee->Manager relationship exists anywhere in this
-- schema (confirmed: employees has no manager_id) — this is entirely new.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS manager_employee_mappings (
  id SERIAL PRIMARY KEY,
  company_id INT REFERENCES companies (id),
  manager_user_id INT NOT NULL REFERENCES users (id),
  employee_id INT NOT NULL REFERENCES employees (id),
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_manager_employee_mappings_employee ON manager_employee_mappings (employee_id);
CREATE INDEX IF NOT EXISTS idx_manager_employee_mappings_manager_user_id ON manager_employee_mappings (manager_user_id);
CREATE INDEX IF NOT EXISTS idx_manager_employee_mappings_company_id ON manager_employee_mappings (company_id);

DROP TRIGGER IF EXISTS trg_manager_employee_mappings_updated_at ON manager_employee_mappings;
CREATE TRIGGER trg_manager_employee_mappings_updated_at BEFORE UPDATE ON manager_employee_mappings
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

COMMIT;
