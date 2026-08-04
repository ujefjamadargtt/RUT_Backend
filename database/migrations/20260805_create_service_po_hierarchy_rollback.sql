-- Rollback for 20260805_create_service_po_hierarchy.sql — safe to run only
-- while no employee_work_logs row actually has hierarchy_node_id set yet.

BEGIN;

DROP INDEX IF EXISTS idx_employee_work_logs_hierarchy_node_id;
ALTER TABLE employee_work_logs DROP COLUMN IF EXISTS hierarchy_node_id;

DROP TRIGGER IF EXISTS trg_service_po_hierarchy_updated_at ON service_po_hierarchy;
DROP TABLE IF EXISTS service_po_hierarchy;

COMMIT;
