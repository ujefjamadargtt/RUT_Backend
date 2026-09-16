-- Rollback for 20260899_fix_project_manager_role_hierarchy.sql
-- Reverts "Project Manager" back to hierarchy_rank/inherits_role_id = NULL.
-- Only run this if you specifically need to undo the backfill — it does NOT
-- restore whatever the exact prior state was on an environment where the
-- rank/inheritance was already correctly set (this migration was a no-op
-- there, so there is nothing to roll back on that environment either).

BEGIN;

UPDATE roles
SET hierarchy_rank = NULL,
    inherits_role_id = NULL,
    updated_at = NOW()
WHERE role_name = 'Project Manager';

COMMIT;
