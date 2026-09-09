-- Rollback for 20260895_add_employee_original_entity_column.sql
-- Run manually if needed — the migration runner never picks this up
-- automatically (see migrationRunner.js's *_rollback.sql exclusion).

ALTER TABLE employees
  DROP COLUMN IF EXISTS original_entity;
