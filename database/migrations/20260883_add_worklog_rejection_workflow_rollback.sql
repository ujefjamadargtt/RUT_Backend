-- Rollback for 20260883_add_worklog_rejection_workflow.sql
-- Not auto-run by the migration runner — apply manually if needed.
--
-- Reverting while any row has status='rejected' would violate the restored
-- constraint — such rows are pushed back to 'pending' first so the rollback
-- never fails partway through (same pattern as
-- 20260852_add_approved_status_to_employee_work_logs_rollback.sql).

BEGIN;

UPDATE employee_work_logs SET status = 'pending' WHERE status = 'rejected';

ALTER TABLE employee_work_logs DROP CONSTRAINT IF EXISTS employee_work_logs_status_check;

ALTER TABLE employee_work_logs
  ADD CONSTRAINT employee_work_logs_status_check
  CHECK (status IN ('pending', 'approved', 'synced'));

ALTER TABLE employee_work_logs
  DROP COLUMN IF EXISTS rejection_remark,
  DROP COLUMN IF EXISTS rejected_by,
  DROP COLUMN IF EXISTS rejected_at;

COMMIT;
