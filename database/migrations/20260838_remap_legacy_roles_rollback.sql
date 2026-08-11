-- Rollback for 20260838_remap_legacy_roles.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.
-- Restores each remapped user's PREVIOUS role using role_migration_log —
-- only works if 20260839_drop_obsolete_roles.sql has NOT yet run (the old
-- role rows must still exist to restore role_id to).

BEGIN;

UPDATE users u
SET role_id = r.id, updated_at = NOW()
FROM role_migration_log log
JOIN roles r ON r.role_name = log.old_role_name
WHERE u.id = log.user_id
  AND log.reason = 'RBAC redesign legacy-role remap';

DELETE FROM role_migration_log WHERE reason = 'RBAC redesign legacy-role remap';

COMMIT;
