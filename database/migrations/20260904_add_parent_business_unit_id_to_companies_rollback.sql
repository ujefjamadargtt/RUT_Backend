-- Rollback for 20260904_add_parent_business_unit_id_to_companies.sql
-- Run manually if needed — the migration runner never picks this up
-- automatically (see migrationRunner.js's *_rollback.sql exclusion).

DROP INDEX IF EXISTS idx_companies_parent_business_unit_id;

ALTER TABLE companies
  DROP COLUMN IF EXISTS parent_business_unit_id;
