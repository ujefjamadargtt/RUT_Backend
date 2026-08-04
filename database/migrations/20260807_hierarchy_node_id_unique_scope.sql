-- =============================================================================
-- Employee Work Logs previously allowed only ONE row per
-- (employee_id, service_po_id, work_date), regardless of hierarchy_node_id.
-- Now that entries can be logged against individual Parent/Child hierarchy
-- nodes under the same Service PO (see service_po_hierarchy /
-- employeeTimesheetService.js), that constraint incorrectly blocked logging
-- hours against more than one node under the same PO on the same day —
-- e.g. 2 hrs against "Parent 1" and 3 hrs against "Parent 2" of the same PO,
-- same date, was rejected as a duplicate of the first insert.
--
-- Rescope uniqueness to (employee_id, service_po_id, hierarchy_node_id,
-- work_date) instead — one row per hierarchy node (or per PO itself, when
-- hierarchy_node_id is NULL) per employee per date.
--
-- hierarchy_node_id is nullable (NULL = hours logged directly against the
-- PO, no node tag), and Postgres treats NULL <> NULL in a plain multi-column
-- UNIQUE constraint — two NULL-hierarchy_node_id rows for the same
-- employee/PO/date would NOT violate a plain 4-column UNIQUE. Using
-- COALESCE(hierarchy_node_id, 0) in the index expression closes that gap —
-- 0 is never a real hierarchy_node id (BIGSERIAL starts at 1).
--
-- The app-level duplicate check (employeeWorkLogRepository.checkDuplicate)
-- enforces this same null-safe scope directly, so this index is a backstop
-- against races/direct DB writes, not the sole guard.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE employee_work_logs DROP CONSTRAINT IF EXISTS uq_employee_work_logs;
DROP INDEX IF EXISTS uq_employee_work_logs;

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_work_logs
  ON employee_work_logs (employee_id, service_po_id, COALESCE(hierarchy_node_id, 0), work_date);

COMMIT;
