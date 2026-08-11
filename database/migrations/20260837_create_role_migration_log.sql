-- =============================================================================
-- RBAC Redesign — Phase 4: role_migration_log.
--
-- Audit trail for every user whose role changed as a direct side effect of
-- this redesign (legacy-role remap, and the user_roles->users.role_id
-- collapse) — so ops can review post-deploy who moved where instead of the
-- remap being a silent, unreviewable UPDATE. Never written to outside this
-- redesign's migrations.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS role_migration_log (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users (id),
  old_role_name VARCHAR(50) NOT NULL,
  new_role_name VARCHAR(50) NOT NULL,
  reason VARCHAR(255),
  migrated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_role_migration_log_user_id ON role_migration_log (user_id);

COMMIT;
