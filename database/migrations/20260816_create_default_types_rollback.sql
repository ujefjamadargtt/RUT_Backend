-- Rollback for 20260816_create_default_types.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.
-- Must be run AFTER rolling back company_types.

BEGIN;

DROP TABLE IF EXISTS default_types;

COMMIT;
