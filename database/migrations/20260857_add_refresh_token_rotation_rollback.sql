-- Rollback for 20260857_add_refresh_token_rotation.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.

BEGIN;

DROP INDEX IF EXISTS idx_user_sessions_jti_revoked_at;
DROP INDEX IF EXISTS idx_user_sessions_family_id;
DROP INDEX IF EXISTS uq_user_sessions_jti;

ALTER TABLE user_sessions
  DROP COLUMN IF EXISTS replaced_by_jti,
  DROP COLUMN IF EXISTS revoked_at,
  DROP COLUMN IF EXISTS family_id,
  DROP COLUMN IF EXISTS jti;

COMMIT;
