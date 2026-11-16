BEGIN;
ALTER TABLE employee_work_logs DROP COLUMN IF EXISTS deleted_via;
ALTER TABLE employee_work_logs DROP COLUMN IF EXISTS deleted_by;
COMMIT;
