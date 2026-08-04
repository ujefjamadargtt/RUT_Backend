-- Rollback for 20260806_fix_service_po_hierarchy_schema.sql — restores the
-- original 20260805 shape. Safe only while service_po_hierarchy is still
-- empty and employee_work_logs.hierarchy_node_id is still all-NULL.

BEGIN;

ALTER TABLE employee_work_logs DROP COLUMN IF EXISTS hierarchy_node_id;
DROP INDEX IF EXISTS idx_employee_work_logs_hierarchy_node_id;

DROP TRIGGER IF EXISTS trg_service_po_hierarchy_updated_at ON service_po_hierarchy;
DROP TABLE IF EXISTS service_po_hierarchy;

CREATE TABLE service_po_hierarchy (
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

CREATE INDEX idx_service_po_hierarchy_service_po_id ON service_po_hierarchy (service_po_id);
CREATE INDEX idx_service_po_hierarchy_parent_hierarchy_id ON service_po_hierarchy (parent_hierarchy_id);
CREATE INDEX idx_service_po_hierarchy_company_id ON service_po_hierarchy (company_id);

CREATE TRIGGER trg_service_po_hierarchy_updated_at BEFORE UPDATE ON service_po_hierarchy
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

ALTER TABLE employee_work_logs
  ADD COLUMN hierarchy_node_id INT REFERENCES service_po_hierarchy (id) ON DELETE SET NULL;
CREATE INDEX idx_employee_work_logs_hierarchy_node_id ON employee_work_logs (hierarchy_node_id);

COMMIT;
