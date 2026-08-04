-- =============================================================================
-- Rollback for 20260807_hierarchy_node_id_unique_scope.sql.
--
-- Restores the original 3-column constraint: UNIQUE (employee_id,
-- service_po_id, work_date). This will FAIL if any rows now exist that
-- collide under that narrower scope (same employee+PO+date, different
-- hierarchy_node_id) — resolve those rows manually (merge or delete) before
-- running this rollback.
-- =============================================================================

BEGIN;

DROP INDEX IF EXISTS uq_employee_work_logs;

ALTER TABLE employee_work_logs
  ADD CONSTRAINT uq_employee_work_logs UNIQUE (employee_id, service_po_id, work_date);

COMMIT;
