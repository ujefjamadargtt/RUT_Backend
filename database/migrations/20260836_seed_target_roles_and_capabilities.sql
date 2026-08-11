-- =============================================================================
-- RBAC Redesign — Phase 3: seed the 9 target roles + their capabilities.
--
-- Target hierarchy (see plan doc):
--   Platform Admin -> Admin -> Entity Admin -> BU Admin -> Project Admin ->
--   Service PO Admin -> Manager -> Employee, with HR as a parallel branch
--   (hierarchy_rank NULL — not part of the numeric admin chain).
--
-- 'Admin', 'Project Admin', 'Service PO Admin', and 'Employee' are brand
-- new role rows (no such roles existed before this redesign). 'Platform
-- Admin', 'Entity Admin', 'BU Admin', 'Manager', 'HR' already exist and are
-- only updated here (rank/inheritance/is_system flag).
--
-- inherits_role_id is set ONLY for the two edges the spec explicitly states
-- ("Service PO Admin inherits every permission available to Manager",
-- "Project Admin inherits every permission available to Service PO Admin").
-- Every other role's capability list (below) is deliberately self-contained
-- per its own "ROLE RESPONSIBILITIES" section in the spec — no invented
-- inheritance for BU Admin/Entity Admin/Admin/Platform Admin.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

INSERT INTO roles (role_name, permission, status, is_system, created_at, updated_at)
VALUES
  ('Platform Admin',    'Read & Write', 'active', true, NOW(), NOW()),
  ('Admin',             'Read & Write', 'active', true, NOW(), NOW()),
  ('Entity Admin',       'Read & Write', 'active', true, NOW(), NOW()),
  ('BU Admin',          'Read & Write', 'active', true, NOW(), NOW()),
  ('Project Admin',      'Read & Write', 'active', true, NOW(), NOW()),
  ('Service PO Admin',   'Read & Write', 'active', true, NOW(), NOW()),
  ('Manager',           'Read & Write', 'active', true, NOW(), NOW()),
  ('Employee',          'Read',         'active', true, NOW(), NOW()),
  ('HR',                'Read & Write', 'active', true, NOW(), NOW())
ON CONFLICT (role_name) DO UPDATE SET is_system = true, status = 'active';

-- Rank + inheritance edges (order matters: Manager before Service PO Admin
-- before Project Admin, since each later UPDATE looks up the previous one's id).
UPDATE roles SET hierarchy_rank = 1, inherits_role_id = NULL WHERE role_name = 'Platform Admin';
UPDATE roles SET hierarchy_rank = 2, inherits_role_id = NULL WHERE role_name = 'Admin';
UPDATE roles SET hierarchy_rank = 3, inherits_role_id = NULL WHERE role_name = 'Entity Admin';
UPDATE roles SET hierarchy_rank = 4, inherits_role_id = NULL WHERE role_name = 'BU Admin';
UPDATE roles SET hierarchy_rank = 7, inherits_role_id = NULL WHERE role_name = 'Manager';
UPDATE roles SET hierarchy_rank = 6, inherits_role_id = (SELECT id FROM roles WHERE role_name = 'Manager')
  WHERE role_name = 'Service PO Admin';
UPDATE roles SET hierarchy_rank = 5, inherits_role_id = (SELECT id FROM roles WHERE role_name = 'Service PO Admin')
  WHERE role_name = 'Project Admin';
UPDATE roles SET hierarchy_rank = 8, inherits_role_id = NULL WHERE role_name = 'Employee';
UPDATE roles SET hierarchy_rank = NULL, inherits_role_id = NULL WHERE role_name = 'HR';

-- Capability grants — one row per bullet in the spec's ROLE RESPONSIBILITIES
-- section. Inherited capabilities (e.g. Manager's onto Service PO Admin) are
-- NEVER duplicated here — src/services/roleHierarchyService.js computes
-- those at read time by walking inherits_role_id.
INSERT INTO role_capabilities (role_id, capability_key)
SELECT r.id, g.capability_key
FROM (VALUES
  ('Platform Admin', 'platform.create_admin'),
  ('Platform Admin', 'platform.manage_role_master'),
  ('Platform Admin', 'platform.manage_form_master'),
  ('Platform Admin', 'platform.manage_platform'),

  ('Admin', 'admin.create_entity_admin'),
  ('Admin', 'admin.create_bu_admin'),
  ('Admin', 'admin.view_entity_admins'),
  ('Admin', 'admin.view_bu_admins'),
  ('Admin', 'admin.manage_entity_admins'),
  ('Admin', 'admin.manage_bu_admins'),

  ('Entity Admin', 'entity.view_bu_admins'),
  ('Entity Admin', 'entity.create_bu_admin'),
  ('Entity Admin', 'entity.view_mapped_employees'),
  ('Entity Admin', 'entity.approve_timesheets'),

  ('BU Admin', 'bu.manage_projects'),
  ('BU Admin', 'bu.create_client'),
  ('BU Admin', 'bu.create_project_admin'),
  ('BU Admin', 'bu.create_servicepo_admin'),
  ('BU Admin', 'bu.view_mapped_employees'),
  ('BU Admin', 'bu.approve_timesheets'),

  ('Project Admin', 'project.manage_servicepos'),
  ('Project Admin', 'project.create_servicepo_admin'),
  ('Project Admin', 'project.view_mapped_employees'),
  ('Project Admin', 'project.approve_timesheets'),

  ('Service PO Admin', 'servicepo.manage_team'),
  ('Service PO Admin', 'servicepo.manage_team_mapping'),
  ('Service PO Admin', 'servicepo.manage_future_budget'),
  ('Service PO Admin', 'servicepo.view_mapped_employees'),
  ('Service PO Admin', 'servicepo.approve_timesheets'),

  ('Manager', 'manager.view_mapped_employees'),
  ('Manager', 'manager.map_employees'),
  ('Manager', 'manager.map_servicepos'),
  ('Manager', 'manager.approve_timesheets'),

  ('Employee', 'employee.view_timesheet'),
  ('Employee', 'employee.fill_worklog'),
  ('Employee', 'employee.view_reports'),

  ('HR', 'hr.create_employee'),
  ('HR', 'hr.manage_employee'),
  ('HR', 'hr.manage_employee_timesheets')
) AS g(role_name, capability_key)
JOIN roles r ON r.role_name = g.role_name
ON CONFLICT (role_id, capability_key) DO NOTHING;

COMMIT;
