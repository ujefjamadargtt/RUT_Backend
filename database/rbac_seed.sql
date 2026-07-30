-- =============================================================================
-- RUT Portal - RBAC Seed Data
-- Form Master, Role <-> Form Mapping, User <-> Role Mapping
-- =============================================================================
-- Captures the current, real RBAC configuration of this application (pulled
-- directly from the live database) as a reproducible, idempotent seed file,
-- so it can be re-applied to a fresh database instead of living only as
-- ad-hoc admin-panel/API changes.
--
-- Prerequisites (run this file AFTER these already exist):
--   - database/seeds.sql (the base roles: HR=1, Finance=2, Division Head=3,
--     Project Manager=4, Management=5; and user id 1, admin@rutportal.com)
--   - users 2 and 3 (management@rutportal.com, mngt@gmail.com), created via
--     the Users API — not part of this file, since seeding application
--     users is out of scope here (only form_master / role_form_mapping /
--     user_roles are).
--
-- The "Super Admin" role (id 6) is NOT part of database/seeds.sql — it was
-- created later via POST /api/v1/roles. It's bootstrapped below anyway
-- (idempotent, ON CONFLICT DO NOTHING) purely so this file's role_form_mapping
-- / user_roles rows have a valid role_id to reference and this file can run
-- standalone on a fresh database — it does not change who owns Role Master
-- seeding (that stays database/seeds.sql's ROLES section).
-- =============================================================================

BEGIN;

-- =============================================================================
-- PREREQUISITE ROLE (see note above — not owned by this file, just needed
-- for the mappings below to have somewhere to point)
-- =============================================================================

INSERT INTO roles (id, role_name, permission, status, created_by, updated_by)
VALUES
  (6, 'Super Admin', 'Read & Write', 'active', 1, 1)
ON CONFLICT (role_name) DO NOTHING;

SELECT setval('roles_id_seq', (SELECT MAX(id) FROM roles));

-- =============================================================================
-- FORM MASTER
-- Every screen/form currently registered in the application, grouped by module.
-- =============================================================================

INSERT INTO form_master (id, module_name, form_name, status)
VALUES
  (1,  'Core',           'Dashboard',                     'active'),
  (2,  'Core',           'AI Insights',                   'active'),
  (3,  'People',         'Employees',                     'active'),
  (4,  'Administration', 'Roles',                         'active'),
  (5,  'Administration', 'Forms',                         'active'),
  (6,  'Administration', 'User Role Mapping',             'active'),
  (7,  'Administration', 'Role Form Mapping',             'active'),
  (8,  'People',         'Users',                         'active'),
  (9,  'Business',       'Clients',                       'active'),
  (10, 'Business',       'Service POs',                   'active'),
  (11, 'Business',       'Sub-Projects',                  'active'),
  (12, 'Business',       'Service Types',                 'active'),
  (13, 'Business',       'Service Categories',            'active'),
  (14, 'Resources',      'Timesheets',                    'active'),
  (15, 'Resources',      'Monthly Costs',                 'active'),
  (16, 'Reports',        'PO vs Resource',                'active'),
  (17, 'Reports',        'Service PO Summary',            'active'),
  (18, 'Reports',        'Monthly Utilization',           'active'),
  (19, 'Reports',        'Resource Allocation',           'active'),
  (20, 'Reports',        'Resource Project Utilization',  'active')
ON CONFLICT (module_name, form_name) DO NOTHING;

SELECT setval('form_master_id_seq', (SELECT MAX(id) FROM form_master));

-- =============================================================================
-- ROLE <-> FORM MAPPING
-- status: true = mapped/active, false = unmapped/inactive (soft mapping —
-- see src/services/rbacService.js). form_id 21 (Employee Hourly Rate) for
-- Super Admin is intentionally seeded as unmapped (false), matching its
-- current live state.
-- =============================================================================

INSERT INTO role_form_mapping (id, role_id, form_id, status)
VALUES
  (1,  6, 1,  true),
  (2,  6, 2,  true),
  (3,  6, 3,  true),
  (4,  3, 7,  true),
  (5,  6, 4,  true),
  (6,  6, 5,  true),
  (7,  6, 7,  true),
  (8,  6, 8,  true),
  (9,  6, 9,  true),
  (10, 4, 9,  true),
  (11, 6, 13, true),
  (12, 6, 12, true),
  (13, 6, 10, true),
  (14, 6, 21, false),
  (15, 6, 18, true),
  (16, 6, 22, true),
  (17, 6, 25, true),
  (18, 6, 19, true),
  (19, 6, 20, true),
  (20, 6, 24, true)
ON CONFLICT (role_id, form_id) DO NOTHING;

SELECT setval('role_form_mapping_id_seq', (SELECT MAX(id) FROM role_form_mapping));

-- =============================================================================
-- USER <-> ROLE MAPPING
-- Real application users' role assignments (distinct from the demo/dummy
-- user_roles rows already seeded by database/seeds.sql for test employees).
-- =============================================================================

INSERT INTO user_roles (id, user_id, role_id)
VALUES
  (41, 1, 6)
ON CONFLICT (user_id, role_id) DO NOTHING;

SELECT setval('user_roles_id_seq', (SELECT MAX(id) FROM user_roles));

COMMIT;
