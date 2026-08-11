-- Rollback for 20260836_seed_target_roles_and_capabilities.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.
-- Only clears the new rank/inheritance/capability data; does NOT delete the
-- 4 brand-new role rows (Admin, Project Admin, Service PO Admin, Employee)
-- since later migrations may already reference them — drop those manually
-- with 20260839_drop_obsolete_roles.sql's rollback pattern if truly needed.

BEGIN;

DELETE FROM role_capabilities
WHERE role_id IN (
  SELECT id FROM roles WHERE role_name IN
  ('Platform Admin', 'Admin', 'Entity Admin', 'BU Admin', 'Project Admin', 'Service PO Admin', 'Manager', 'Employee', 'HR')
);

UPDATE roles SET hierarchy_rank = NULL, inherits_role_id = NULL, is_system = false
WHERE role_name IN
  ('Platform Admin', 'Admin', 'Entity Admin', 'BU Admin', 'Project Admin', 'Service PO Admin', 'Manager', 'Employee', 'HR');

COMMIT;
