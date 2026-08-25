-- =============================================================================
-- Employee-as-Identity Redesign — Phase 2: employee_roles.
--
-- An Employee may hold multiple roles simultaneously (many-to-many),
-- replacing the old single users.role_id + additive user_additional_roles
-- split. This table is the SOLE source of an employee's roles going
-- forward — there is no primary/additional distinction here; every
-- consumer (capability union, effective hierarchy rank = MIN(hierarchy_rank)
-- across active rows) treats the set uniformly. See roleHierarchyService.js.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS employee_roles (
  id SERIAL PRIMARY KEY,
  employee_id INT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  role_id INT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_roles_employee_role ON employee_roles (employee_id, role_id);
CREATE INDEX IF NOT EXISTS idx_employee_roles_employee_id ON employee_roles (employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_roles_role_id ON employee_roles (role_id);

DROP TRIGGER IF EXISTS trg_employee_roles_updated_at ON employee_roles;
CREATE TRIGGER trg_employee_roles_updated_at BEFORE UPDATE ON employee_roles
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

COMMIT;
