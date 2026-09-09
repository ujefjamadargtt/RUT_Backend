-- Rollback for 20260893_add_employee_payroll_location_columns.sql
-- Run manually if needed — the migration runner never picks this up
-- automatically (see migrationRunner.js's *_rollback.sql exclusion).

ALTER TABLE employees
  DROP COLUMN IF EXISTS payroll_entity,
  DROP COLUMN IF EXISTS location,
  DROP COLUMN IF EXISTS sub_location;
