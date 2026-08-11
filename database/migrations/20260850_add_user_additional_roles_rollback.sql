-- Rollback for 20260850_add_user_additional_roles.sql
-- Not auto-run by the migration runner — apply manually if needed.

BEGIN;

DROP TRIGGER IF EXISTS trg_user_additional_roles_updated_at ON user_additional_roles;
DROP TABLE IF EXISTS user_additional_roles;

COMMIT;
