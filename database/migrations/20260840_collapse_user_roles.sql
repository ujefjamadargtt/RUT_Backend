-- =============================================================================
-- RBAC Redesign — Phase 7: collapse dual role storage.
--
-- Today a user's role is stored twice — the single `users.role_id` FK and
-- the many-to-many `user_roles` table — with nothing indicating which is
-- authoritative (confirmed divergent in practice: user 1 holds different
-- role sets depending which one you read). The new hierarchy is strictly
-- one-role-per-user, so `users.role_id` becomes the SOLE source of truth.
--
-- Any user_roles row that names a role OTHER than the user's current
-- `role_id` is a discarded secondary role — logged to role_migration_log
-- for review before the table is dropped, not silently lost.
--
-- Safe to re-run: once user_roles is dropped, the SELECT/INSERT and the
-- DROP TABLE both become no-ops.
-- =============================================================================

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_roles') THEN
    INSERT INTO role_migration_log (user_id, old_role_name, new_role_name, reason)
    SELECT ur.user_id, r.role_name, COALESCE(pr.role_name, '(none)'),
      'user_roles secondary role discarded — users.role_id is now the sole source of truth'
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    JOIN users u ON u.id = ur.user_id
    LEFT JOIN roles pr ON pr.id = u.role_id
    WHERE ur.role_id IS DISTINCT FROM u.role_id;
  END IF;
END $$;

DROP TABLE IF EXISTS user_roles;

COMMIT;
