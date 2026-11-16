-- Rollback for 20261114_employee_work_logs_soft_delete.sql.
-- Soft-deleted rows are removed for good (they were deleted from the app's point of view).
BEGIN;

DROP INDEX IF EXISTS idx_employee_work_logs_deleted;
DELETE FROM employee_work_logs WHERE deleted_at IS NOT NULL;

DROP INDEX IF EXISTS uq_employee_work_logs;
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_work_logs
  ON employee_work_logs (employee_id, service_po_id, COALESCE(hierarchy_node_id, 0), work_date);

ALTER TABLE employee_work_logs DROP COLUMN IF EXISTS deleted_at;

COMMIT;
