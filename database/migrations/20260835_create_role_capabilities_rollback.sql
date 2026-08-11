-- Rollback for 20260835_create_role_capabilities.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.

BEGIN;

DROP TABLE IF EXISTS role_capabilities;

COMMIT;
