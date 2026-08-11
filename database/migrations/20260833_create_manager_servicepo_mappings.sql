-- =============================================================================
-- Manager Service PO Mapping — a Head Manager's grant of a Service PO to
-- one of their own Managers. Many-to-many (unlike the two mapping tables
-- above) — a Manager can be granted several Service POs, and the same
-- Service PO can be granted to several Managers; only exact-duplicate
-- grants are prevented.
--
-- This grant is a CASCADING RESTRICTION, not just informational: when a
-- Manager later assigns a Service PO to one of their own Employees (via
-- the existing employee_servicepo_mapping table/flow), the chosen Service
-- PO must already appear here for that Manager (see
-- managerSelfServiceService.js).
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS manager_servicepo_mappings (
  id SERIAL PRIMARY KEY,
  company_id INT REFERENCES companies (id),
  manager_user_id INT NOT NULL REFERENCES users (id),
  service_po_id INT NOT NULL REFERENCES service_pos (id),
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_manager_servicepo_mappings ON manager_servicepo_mappings (manager_user_id, service_po_id);
CREATE INDEX IF NOT EXISTS idx_manager_servicepo_mappings_company_id ON manager_servicepo_mappings (company_id);

DROP TRIGGER IF EXISTS trg_manager_servicepo_mappings_updated_at ON manager_servicepo_mappings;
CREATE TRIGGER trg_manager_servicepo_mappings_updated_at BEFORE UPDATE ON manager_servicepo_mappings
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

COMMIT;
