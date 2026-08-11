-- Rollback for 20260841_drop_users_is_platform_admin.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.
-- Restores the column (default false for everyone — the original flag
-- values are not recoverable) and drops the new uniqueness guard.

BEGIN;

DROP INDEX IF EXISTS uq_users_employee_id;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN NOT NULL DEFAULT false;

COMMIT;
