-- Rollback for 20260852_add_approved_status_to_employee_work_logs.sql
-- Not auto-run by the migration runner — apply manually if needed.
--
-- Reverting while any row has status='approved' would violate the restored
-- constraint — such rows are pushed back to 'pending' first so the rollback
-- never fails partway through.

BEGIN;

UPDATE employee_work_logs SET status = 'pending' WHERE status = 'approved';

ALTER TABLE employee_work_logs DROP CONSTRAINT IF EXISTS employee_work_logs_status_check;

ALTER TABLE employee_work_logs
  ADD CONSTRAINT employee_work_logs_status_check
  CHECK (status IN ('pending', 'synced'));

COMMIT;
