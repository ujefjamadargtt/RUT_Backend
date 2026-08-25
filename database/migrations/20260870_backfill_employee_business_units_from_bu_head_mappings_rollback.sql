-- Rollback for 20260870_backfill_employee_business_units_from_bu_head_mappings.sql
-- Not auto-run by the migration runner — apply manually if needed.

BEGIN;

DELETE FROM employee_business_units eb
WHERE EXISTS (
  SELECT 1 FROM bu_head_company_mappings m
  JOIN users u ON u.id = m.bu_head_user_id
  WHERE u.employee_id = eb.employee_id AND m.company_id = eb.business_unit_id
);

COMMIT;
