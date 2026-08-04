-- =============================================================================
-- Corrects 20260805_create_service_po_hierarchy.sql's column types/shape to
-- match the finalized spec exactly:
--   - id/service_po_id/parent_hierarchy_id: BIGSERIAL/BIGINT, not SERIAL/INT
--   - node_name: VARCHAR(255), not VARCHAR(200)
--   - status: BOOLEAN DEFAULT TRUE, not VARCHAR('active'/'inactive')
--   - no company_id column — tenant scoping is derived through service_po_id
--     -> service_pos.company_id instead of a redundant column on this table
--     (see servicePOHierarchyService.js, which always resolves ownership via
--     servicePORepository.findById(node.service_po_id, companyId))
--
-- Safe to DROP and recreate rather than ALTER: service_po_hierarchy has zero
-- rows and employee_work_logs.hierarchy_node_id is NULL on every row as of
-- this migration (verified live before writing this file) — this feature
-- was added and immediately reverted/corrected within the same day, never
-- reaching real usage.
-- =============================================================================

BEGIN;

ALTER TABLE employee_work_logs DROP COLUMN IF EXISTS hierarchy_node_id;
DROP INDEX IF EXISTS idx_employee_work_logs_hierarchy_node_id;

DROP TRIGGER IF EXISTS trg_service_po_hierarchy_updated_at ON service_po_hierarchy;
DROP TABLE IF EXISTS service_po_hierarchy;

CREATE TABLE service_po_hierarchy (
  id BIGSERIAL PRIMARY KEY,
  service_po_id BIGINT NOT NULL REFERENCES service_pos (id),
  parent_hierarchy_id BIGINT REFERENCES service_po_hierarchy (id),
  node_name VARCHAR(255) NOT NULL,
  node_type VARCHAR(20) NOT NULL CHECK (node_type IN ('PARENT', 'CHILD')),
  display_order INT NOT NULL DEFAULT 0,
  status BOOLEAN NOT NULL DEFAULT TRUE,
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_service_po_hierarchy_service_po_id ON service_po_hierarchy (service_po_id);
CREATE INDEX idx_service_po_hierarchy_parent_hierarchy_id ON service_po_hierarchy (parent_hierarchy_id);

CREATE TRIGGER trg_service_po_hierarchy_updated_at BEFORE UPDATE ON service_po_hierarchy
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- Re-add the Employee Timesheet integration column against the corrected
-- table/type. ON DELETE SET NULL matches employee_work_logs' existing
-- timesheet_import_id FK convention — never read by sync/import/reports.
ALTER TABLE employee_work_logs
  ADD COLUMN hierarchy_node_id BIGINT REFERENCES service_po_hierarchy (id) ON DELETE SET NULL;
CREATE INDEX idx_employee_work_logs_hierarchy_node_id ON employee_work_logs (hierarchy_node_id);

COMMIT;
