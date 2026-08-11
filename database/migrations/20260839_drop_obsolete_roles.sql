-- =============================================================================
-- RBAC Redesign — Phase 6: remove roles that no longer exist in the new
-- hierarchy. Must run AFTER 20260838 (every holder has already been
-- remapped off these roles). role_form_mapping and user_roles rows for
-- these roles cascade-delete automatically (both FKs are ON DELETE CASCADE);
-- users.role_id is ON DELETE SET NULL, so any user missed by the remap
-- (there should be none) becomes roleless rather than erroring, and would
-- show up immediately via a failed authenticate() check post-deploy.
--
-- Safe to re-run (DELETE ... WHERE role_name IN (...) is a no-op once gone).
-- =============================================================================

BEGIN;

DELETE FROM roles
WHERE role_name IN ('Super Admin', 'Head Manager', 'BU HR Head', 'Division Head', 'Project Manager', 'Management', 'Finance');

COMMIT;
