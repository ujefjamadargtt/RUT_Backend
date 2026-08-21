-- Rollback for 20260861_add_bu_head_role.sql
-- Only removes the role row itself if nothing references it — the app-layer
-- delete guards (roleRepository.hasAssignedUsers) apply to interactive
-- deletes; this rollback is a manual, deliberate reversal, so it checks the
-- same invariant directly rather than assuming no BU Head users exist yet.

BEGIN;

DELETE FROM roles
WHERE role_name = 'BU Head'
  AND NOT EXISTS (SELECT 1 FROM users WHERE role_id = roles.id)
  AND NOT EXISTS (
    SELECT 1 FROM user_additional_roles uar
    JOIN roles r2 ON r2.id = uar.role_id
    WHERE r2.role_name = 'BU Head'
  );

COMMIT;
