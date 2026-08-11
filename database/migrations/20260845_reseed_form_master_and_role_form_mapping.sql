-- =============================================================================
-- RBAC Redesign — Phase 12: Form Master reseed.
--
-- Form-visibility mapping per the spec's FORM MASTER section. Unlike the
-- capability engine (role_capabilities/roleHierarchyService — Stage 2),
-- this layer is NOT inherited: every role's form list below is exactly and
-- only what the spec lists for that role, taken verbatim. Platform Admin is
-- deliberately excluded — "All Forms" is implemented as an implicit bypass
-- in the forms-resolution query (hierarchy_rank = 1 ⇒ every active form),
-- not stored rows, so it never needs reseeding when a new form is added.
--
-- Pre-existing forms (Dashboard, AI Insights, old Employees/Users/Clients/
-- Service POs/Timesheets/Monthly Costs/Reports screens, Roles, Forms, User
-- Role Mapping, Role Form Mapping) are left untouched in form_master —
-- Platform Admin's bypass still needs them to exist and stay active. Only
-- role_form_mapping rows for the 8 non-Platform-Admin target roles are
-- reset here.
--
-- Safe to re-run (reset-then-insert every time).
-- =============================================================================

BEGIN;

INSERT INTO form_master (module_name, form_name, status, created_at, updated_at)
VALUES
  ('Entity Management', 'Entity Admin Master',     'active', NOW(), NOW()),
  ('Administration',    'Project Admin Master',    'active', NOW(), NOW()),
  ('Administration',    'Service PO Admin Master', 'active', NOW(), NOW()),
  ('Administration',    'Team Management',         'active', NOW(), NOW()),
  ('People',             'Employee List',           'active', NOW(), NOW()),
  ('People',             'Employee Mapping',        'active', NOW(), NOW()),
  ('People',             'Employee Master',         'active', NOW(), NOW()),
  ('Business',           'Client Master',           'active', NOW(), NOW()),
  ('Business',           'Project Master',          'active', NOW(), NOW()),
  ('Business',           'Service PO Master',       'active', NOW(), NOW()),
  ('Business',           'Service PO Mapping',      'active', NOW(), NOW()),
  ('Resources',          'Timesheet',               'active', NOW(), NOW()),
  ('Resources',          'Timesheet Approval',      'active', NOW(), NOW()),
  ('Reports',            'Reports',                 'active', NOW(), NOW())
ON CONFLICT (module_name, form_name) DO NOTHING;
-- 'Entity Master' and 'BU Admin Master' (module 'Entity Management') already
-- exist as of 20260827_add_entity_admin_forms.sql.

-- Reset every existing mapping for the 8 target roles that DO store rows
-- (Platform Admin is excluded — see header comment).
UPDATE role_form_mapping
SET status = false, updated_at = NOW()
WHERE status = true
  AND role_id IN (
    SELECT id FROM roles WHERE role_name IN
      ('Admin', 'Entity Admin', 'BU Admin', 'Project Admin', 'Service PO Admin', 'Manager', 'Employee', 'HR')
  );

INSERT INTO role_form_mapping (role_id, form_id, status, created_at, updated_at)
SELECT r.id, fm.id, true, NOW(), NOW()
FROM (VALUES
  ('Admin', 'Entity Management', 'Entity Admin Master'),
  ('Admin', 'Entity Management', 'BU Admin Master'),

  ('Entity Admin', 'Entity Management', 'Entity Master'),
  ('Entity Admin', 'Entity Management', 'BU Admin Master'),
  ('Entity Admin', 'People', 'Employee List'),
  ('Entity Admin', 'Resources', 'Timesheet Approval'),

  ('BU Admin', 'Business', 'Client Master'),
  ('BU Admin', 'Business', 'Project Master'),
  ('BU Admin', 'Administration', 'Project Admin Master'),
  ('BU Admin', 'Administration', 'Service PO Admin Master'),
  ('BU Admin', 'People', 'Employee List'),
  ('BU Admin', 'Resources', 'Timesheet Approval'),

  ('Project Admin', 'Business', 'Project Master'),
  ('Project Admin', 'Business', 'Service PO Master'),
  ('Project Admin', 'Administration', 'Service PO Admin Master'),
  ('Project Admin', 'People', 'Employee List'),
  ('Project Admin', 'Resources', 'Timesheet Approval'),

  ('Service PO Admin', 'Administration', 'Team Management'),
  ('Service PO Admin', 'People', 'Employee List'),
  ('Service PO Admin', 'Resources', 'Timesheet Approval'),

  ('Manager', 'People', 'Employee Mapping'),
  ('Manager', 'Business', 'Service PO Mapping'),
  ('Manager', 'Resources', 'Timesheet Approval'),

  ('Employee', 'Resources', 'Timesheet'),
  ('Employee', 'Reports', 'Reports'),

  ('HR', 'People', 'Employee Master'),
  ('HR', 'Resources', 'Timesheet')
) AS grant_row(role_name, module_name, form_name)
JOIN roles r ON r.role_name = grant_row.role_name
JOIN form_master fm ON fm.module_name = grant_row.module_name AND fm.form_name = grant_row.form_name
ON CONFLICT (role_id, form_id) DO UPDATE SET status = true, updated_at = NOW();

COMMIT;
