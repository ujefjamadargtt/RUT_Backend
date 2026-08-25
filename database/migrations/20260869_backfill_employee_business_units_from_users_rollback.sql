-- Rollback for 20260869_backfill_employee_business_units_from_users.sql
-- Not auto-run by the migration runner — apply manually if needed.

BEGIN;

DELETE FROM employee_business_units eb
WHERE EXISTS (
  SELECT 1 FROM users u WHERE u.employee_id = eb.employee_id AND u.company_id = eb.business_unit_id
);

COMMIT;
