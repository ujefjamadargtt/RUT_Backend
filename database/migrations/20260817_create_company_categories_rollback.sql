-- Rollback for 20260817_create_company_categories.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.
-- Must be run AFTER rolling back company_types.

BEGIN;

DROP TABLE IF EXISTS company_categories;

COMMIT;
