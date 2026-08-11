-- Rollback for 20260837_create_role_migration_log.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.

BEGIN;

DROP TABLE IF EXISTS role_migration_log;

COMMIT;
