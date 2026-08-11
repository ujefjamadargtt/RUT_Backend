-- Rollback for 20260818_create_company_types.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.

BEGIN;

DROP TABLE IF EXISTS company_types;

COMMIT;
