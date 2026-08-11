-- Rollback for 20260832_create_manager_employee_mappings.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.

BEGIN;

DROP TRIGGER IF EXISTS trg_manager_employee_mappings_updated_at ON manager_employee_mappings;
DROP TABLE IF EXISTS manager_employee_mappings;

COMMIT;
