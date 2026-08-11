-- Rollback for 20260815_create_default_categories.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.
-- Must be run AFTER rolling back everything that references this table
-- (default_types, company_categories).

BEGIN;

DROP TABLE IF EXISTS default_categories;

COMMIT;
