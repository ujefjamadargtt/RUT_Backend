-- =============================================================================
-- Employee-as-Identity Redesign — Phase 3: employee_business_units.
--
-- An Employee may belong to multiple Business Units simultaneously
-- (many-to-many), replacing the old single users.company_id column and the
-- BU-Head-only bu_head_company_mappings mechanism (retired separately, see
-- 20260871_drop_bu_head_company_mappings.sql — its data is migrated here
-- first). "Business Unit" = the existing `companies` table; no duplicate BU
-- table is created.
--
-- This is the table src/middlewares/resolveCompany.js reads to resolve a
-- request's active BU going forward, generalizing what today only the BU
-- Head role gets (a request-selected company validated against a mapping
-- table) to every role.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS employee_business_units (
  id SERIAL PRIMARY KEY,
  employee_id INT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  business_unit_id INT NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_business_units_employee_bu ON employee_business_units (employee_id, business_unit_id);
CREATE INDEX IF NOT EXISTS idx_employee_business_units_employee_id ON employee_business_units (employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_business_units_business_unit_id ON employee_business_units (business_unit_id);

DROP TRIGGER IF EXISTS trg_employee_business_units_updated_at ON employee_business_units;
CREATE TRIGGER trg_employee_business_units_updated_at BEFORE UPDATE ON employee_business_units
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

COMMIT;
