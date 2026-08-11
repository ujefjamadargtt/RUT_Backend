-- Rollback for 20260843_manager_employee_mappings_add_type.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.
-- Only safe if no employee has both a PRIMARY and SECONDARY mapping row
-- (the old single-column unique index cannot represent that).

BEGIN;

DROP INDEX IF EXISTS uq_manager_employee_mappings_employee_type;
CREATE UNIQUE INDEX IF NOT EXISTS uq_manager_employee_mappings_employee ON manager_employee_mappings (employee_id);
ALTER TABLE manager_employee_mappings DROP COLUMN IF EXISTS mapping_type;

COMMIT;
