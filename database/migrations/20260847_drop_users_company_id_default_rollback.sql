-- Rollback for 20260847_drop_users_company_id_default.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.

BEGIN;

ALTER TABLE users ALTER COLUMN company_id SET DEFAULT 1;

COMMIT;
