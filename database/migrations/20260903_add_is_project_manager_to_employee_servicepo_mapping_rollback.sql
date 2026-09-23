-- Rollback for 20260903_add_is_project_manager_to_employee_servicepo_mapping.sql.

BEGIN;

DROP INDEX IF EXISTS idx_employee_servicepo_mapping_is_project_manager;

ALTER TABLE employee_servicepo_mapping
  DROP COLUMN IF EXISTS is_project_manager;

COMMIT;
