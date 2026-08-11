-- =============================================================================
-- Manager Mapping — a Head Manager (or BU Admin, via the existing
-- authorize.js superuser bypass) maps other Users under themselves as
-- "Managers". Being mapped here is what makes a User a "Manager" in this
-- feature — there is no separate pre-existing "Manager" role a User must
-- already hold (mirrors employee_servicepo_mapping's own pattern of not
-- restricting which Employees can be mapped).
--
-- Duplicate-mapping protection is enforced at the DB level via the unique
-- constraint below (mirrors uq_employee_servicepo_mapping's pattern) —
-- never just an application-level check.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS manager_mappings (
  id SERIAL PRIMARY KEY,
  company_id INT REFERENCES companies (id),
  manager_user_id INT NOT NULL REFERENCES users (id),
  mapped_user_id INT NOT NULL REFERENCES users (id),
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_manager_mappings_not_self CHECK (manager_user_id <> mapped_user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_manager_mappings ON manager_mappings (manager_user_id, mapped_user_id);
CREATE INDEX IF NOT EXISTS idx_manager_mappings_company_id ON manager_mappings (company_id);
CREATE INDEX IF NOT EXISTS idx_manager_mappings_manager_user_id ON manager_mappings (manager_user_id);
CREATE INDEX IF NOT EXISTS idx_manager_mappings_mapped_user_id ON manager_mappings (mapped_user_id);

DROP TRIGGER IF EXISTS trg_manager_mappings_updated_at ON manager_mappings;
CREATE TRIGGER trg_manager_mappings_updated_at BEFORE UPDATE ON manager_mappings
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

COMMIT;
