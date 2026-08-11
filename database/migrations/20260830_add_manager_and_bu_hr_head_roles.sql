-- =============================================================================
-- Adds the "Manager" and "BU HR Head" roles — completes the hierarchy
-- Platform Admin -> Entity Admin -> BU Admin -> BU HR Head / Head Manager
-- -> Manager -> Employee ("Head Manager" was already seeded — see
-- 20260820_add_head_manager_role.sql). BU Admin creates users holding
-- these two plus Head Manager (see userService.js's new role restriction);
-- BU HR Head has no further backend behavior defined by this feature.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

INSERT INTO roles (role_name, permission, status, created_at, updated_at)
VALUES
  ('Manager', 'Read & Write', 'active', NOW(), NOW()),
  ('BU HR Head', 'Read & Write', 'active', NOW(), NOW())
ON CONFLICT (role_name) DO NOTHING;

COMMIT;
