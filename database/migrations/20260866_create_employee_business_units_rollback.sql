-- Rollback for 20260866_create_employee_business_units.sql
-- Not auto-run by the migration runner — apply manually if needed.

BEGIN;

DROP TRIGGER IF EXISTS trg_employee_business_units_updated_at ON employee_business_units;
DROP TABLE IF EXISTS employee_business_units;

COMMIT;
