-- =============================================================================
-- Soft delete for employee_work_logs.
--
-- The employee calendar (GET /employee-timesheets/calendar) now shows, per day,
-- how many work-log lines the employee deleted. That needs deletes to be
-- recorded, so a deleted line keeps its row and is stamped with deleted_at
-- instead of being removed. Every reader of employee_work_logs excludes rows
-- with deleted_at set (Sequelize `paranoid` on the model; explicit
-- `deleted_at IS NULL` in raw SQL).
--
-- The functional unique index uq_employee_work_logs must only cover live rows,
-- otherwise re-logging a deleted (employee, Service PO, node, date) would be
-- rejected as a duplicate of its own tombstone.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE employee_work_logs ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;

DROP INDEX IF EXISTS uq_employee_work_logs;
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_work_logs
  ON employee_work_logs (employee_id, service_po_id, COALESCE(hierarchy_node_id, 0), work_date)
  WHERE deleted_at IS NULL;

-- Calendar "deleted" count: tombstones per employee per month.
CREATE INDEX IF NOT EXISTS idx_employee_work_logs_deleted
  ON employee_work_logs (employee_id, work_date)
  WHERE deleted_at IS NOT NULL;

COMMIT;
