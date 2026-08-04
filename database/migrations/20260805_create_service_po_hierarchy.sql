-- =============================================================================
-- Service PO Hierarchy — dedicated table, NOT a parent_id on service_pos.
--
-- Hierarchy belongs to exactly ONE Service PO. Inside that PO there are
-- PARENT nodes (parent_hierarchy_id NULL) and, under each PARENT, CHILD
-- nodes (parent_hierarchy_id = the PARENT's id). Max depth is 2 inside one
-- PO (Service PO -> Parent -> Child) — a CHILD can never itself be a
-- parent_hierarchy_id target; that's enforced in servicePOHierarchyService.js,
-- not here.
--
-- service_pos itself is untouched by this migration (no parent_id column) —
-- this is a completely separate concept from any prior self-referencing PO
-- hierarchy attempt.
--
-- company_id/created_by/updated_by are additive to the spec's column list,
-- added only for consistency with every other table in this multi-tenant
-- app (service_pos, employee_servicepo_mapping, employee_work_logs all
-- carry the same three columns) — see servicePOHierarchyService.js for how
-- they're populated.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS service_po_hierarchy (
  id SERIAL PRIMARY KEY,
  company_id INT REFERENCES companies (id),
  service_po_id INT NOT NULL REFERENCES service_pos (id),
  parent_hierarchy_id INT REFERENCES service_po_hierarchy (id),
  node_name VARCHAR(200) NOT NULL,
  node_type VARCHAR(10) NOT NULL CHECK (node_type IN ('PARENT', 'CHILD')),
  display_order INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_po_hierarchy_service_po_id ON service_po_hierarchy (service_po_id);
CREATE INDEX IF NOT EXISTS idx_service_po_hierarchy_parent_hierarchy_id ON service_po_hierarchy (parent_hierarchy_id);
CREATE INDEX IF NOT EXISTS idx_service_po_hierarchy_company_id ON service_po_hierarchy (company_id);

DROP TRIGGER IF EXISTS trg_service_po_hierarchy_updated_at ON service_po_hierarchy;
CREATE TRIGGER trg_service_po_hierarchy_updated_at BEFORE UPDATE ON service_po_hierarchy
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- Employee Timesheet integration: an employee's work log entry keeps its
-- existing, required service_po_id (sync only ever reads that column,
-- exactly as today) and optionally also tags which hierarchy node (Parent
-- or Child) the hours were logged against, purely for the employee's own
-- selection UI/history — never read by sync, import, or reports.
-- ON DELETE SET NULL mirrors this table's existing timesheet_import_id FK
-- (see 20260731_employee_work_logs_import_fk_set_null.sql) — deleting a
-- hierarchy node must never block or cascade-delete a historical work log
-- entry; the entry just loses its hierarchy tag and keeps its service_po_id.
ALTER TABLE employee_work_logs
  ADD COLUMN IF NOT EXISTS hierarchy_node_id INT REFERENCES service_po_hierarchy (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_employee_work_logs_hierarchy_node_id ON employee_work_logs (hierarchy_node_id);

COMMIT;
