-- Rollback for 20260840_collapse_user_roles.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.
-- Recreates an EMPTY user_roles table (structure only) — the discarded
-- secondary-role rows are only recoverable from role_migration_log, not
-- automatically replayed back into the table.

BEGIN;

CREATE TABLE IF NOT EXISTS user_roles (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_id INT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_roles_user_role ON user_roles (user_id, role_id);

COMMIT;
