-- Rollback for 20260834_add_role_hierarchy_columns.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.

BEGIN;

DROP INDEX IF EXISTS idx_roles_hierarchy_rank;
ALTER TABLE roles DROP COLUMN IF EXISTS is_system;
ALTER TABLE roles DROP COLUMN IF EXISTS inherits_role_id;
ALTER TABLE roles DROP COLUMN IF EXISTS hierarchy_rank;

COMMIT;
