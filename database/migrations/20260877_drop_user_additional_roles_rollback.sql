-- Rollback for 20260877_drop_user_additional_roles.sql
-- Not auto-run by the migration runner — apply manually if needed.
-- Recreates the empty table structure only — original rows are not
-- recoverable; restore from a backup taken before this migration if needed.

BEGIN;

CREATE TABLE IF NOT EXISTS user_additional_roles (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_id INT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_additional_roles_user_role
  ON user_additional_roles (user_id, role_id);
CREATE INDEX IF NOT EXISTS idx_user_additional_roles_user_id
  ON user_additional_roles (user_id);

DROP TRIGGER IF EXISTS trg_user_additional_roles_updated_at ON user_additional_roles;
CREATE TRIGGER trg_user_additional_roles_updated_at BEFORE UPDATE ON user_additional_roles
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

COMMIT;
