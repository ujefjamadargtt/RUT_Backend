-- Rollback for 20260897_rename_manager_role_to_team_lead.sql
-- Run manually if needed — the migration runner never picks this up
-- automatically (see migrationRunner.js's *_rollback.sql exclusion).

BEGIN;

UPDATE roles
SET role_name = 'Manager', updated_at = NOW()
WHERE role_name = 'Team Lead';

COMMIT;
