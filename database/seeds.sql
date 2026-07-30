-- =============================================================================
-- RUT Portal - Resource Utilization Tracking
-- Seed Data
-- =============================================================================
-- Admin password: Admin@123
-- bcrypt hash (cost factor 12) generated for 'Admin@123':
--   $2b$12$a6Ex/FZQ1fMXPJdgk9qGduLv8bvvVK6F87xamgf2mC5m51ZxxXGmq
-- Note: Regenerate this hash in Node.js before first deploy:
--   const bcrypt = require('bcrypt');
--   bcrypt.hash('Admin@123', 12).then(console.log);
-- =============================================================================

BEGIN;

-- =============================================================================
-- ROLES
-- =============================================================================

INSERT INTO roles (id, role_name, permission, status, created_by, updated_by)
VALUES
  (1, 'HR',              'Read',         'active', 1, 1),
  (2, 'Finance',         'Read',         'active', 1, 1),
  (3, 'Division Head',   'Read & Write', 'active', 1, 1),
  (4, 'Project Manager', 'Read & Write', 'active', 1, 1),
  (5, 'Management',      'Read & Write', 'active', 1, 1)
ON CONFLICT (role_name) DO NOTHING;

-- Keep sequence in sync after explicit ID inserts
SELECT setval('roles_id_seq', (SELECT MAX(id) FROM roles));

-- =============================================================================
-- SERVICE TYPES
-- =============================================================================

INSERT INTO service_types (id, service_type_name, created_by, updated_by)
VALUES
  (1, 'Project',               1, 1),
  (2, 'Service Pack',          1, 1),
  (3, 'Resource Outsourcing',  1, 1),
  (4, 'Managed Services',      1, 1)
ON CONFLICT (service_type_name) DO NOTHING;

SELECT setval('service_types_id_seq', (SELECT MAX(id) FROM service_types));

-- =============================================================================
-- ADMIN EMPLOYEE
-- =============================================================================

INSERT INTO employees (
  id,
  employee_code,
  full_name,
  designation,
  total_experience,
  company_experience,
  resource_description,
  date_of_joining,
  status,
  created_by,
  updated_by
)
VALUES (
  1,
  'EMP-001',
  'System Administrator',
  'Administrator',
  0.0,
  0.0,
  'System administrator account. Do not delete.',
  CURRENT_DATE,
  'active',
  1,
  1
)
ON CONFLICT (employee_code) DO NOTHING;

SELECT setval('employees_id_seq', (SELECT MAX(id) FROM employees));

-- =============================================================================
-- ADMIN USER
-- Password: Admin@123
-- bcrypt hash (cost 12):
--   $2b$12$a6Ex/FZQ1fMXPJdgk9qGduLv8bvvVK6F87xamgf2mC5m51ZxxXGmq
-- IMPORTANT: Replace this hash with one freshly generated in your Node.js app
--            before deploying to production. See note at top of file.
-- =============================================================================

INSERT INTO users (
  id,
  employee_id,
  email,
  password,
  role_id,
  status,
  created_by,
  updated_by
)
VALUES (
  1,
  1,
  'admin@rutportal.com',
  '$2b$12$a6Ex/FZQ1fMXPJdgk9qGduLv8bvvVK6F87xamgf2mC5m51ZxxXGmq',
  5,   -- Management role
  'active',
  1,
  1
)
ON CONFLICT (email) DO NOTHING;

SELECT setval('users_id_seq', (SELECT MAX(id) FROM users));

-- =============================================================================
-- USER ROLES
-- =============================================================================

INSERT INTO user_roles (user_id, role_id, created_at)
VALUES
  (1, 5, NOW()),
  (1, 1, NOW()),
  (2, 4, NOW()),
  (3, 4, NOW()),
  (4, 2, NOW())
ON CONFLICT (user_id, role_id) DO NOTHING;

SELECT setval('user_roles_id_seq', (SELECT MAX(id) FROM user_roles));

-- =============================================================================
-- DUMMY DATA FOR TESTING
-- =============================================================================

-- CLIENTS
INSERT INTO clients (id, client_code, client_name, industry, status, created_by, updated_by)
VALUES
  (1, 'CL-001', 'Acme Technologies', 'Information Technology', 'active', 1, 1),
  (2, 'CL-002', 'Zenith Retail', 'Retail', 'active', 1, 1)
ON CONFLICT (client_code) DO NOTHING;

SELECT setval('clients_id_seq', GREATEST((SELECT MAX(id) FROM clients), 2));

-- SERVICE POs
INSERT INTO service_pos (
  id,
  service_po_code,
  service_po_name,
  client_id,
  service_type_id,
  po_value,
  start_date,
  end_date,
  expected_man_hours,
  is_billable,
  status,
  created_by,
  updated_by
)
VALUES
  (1, 'PO-001', 'Acme Website Revamp', 1, 1, 120000.00, '2026-01-01', '2026-12-31', 2000, TRUE, 'active', 1, 1),
  (2, 'PO-002', 'Zenith Store Migration', 2, 2, 85000.00, '2026-03-01', '2026-09-30', 1400, TRUE, 'active', 1, 1)
ON CONFLICT (service_po_code) DO NOTHING;

SELECT setval('service_pos_id_seq', GREATEST((SELECT MAX(id) FROM service_pos), 2));

-- SUB-PROJECTS
INSERT INTO sub_projects (
  id,
  sub_project_code,
  service_po_id,
  sub_project_name,
  description,
  start_date,
  end_date,
  status,
  created_by,
  updated_by
)
VALUES
  (1, 'SP-001', 1, 'Frontend Modernization', 'UI/UX overhaul for Acme portal', '2026-01-01', '2026-06-30', 'active', 1, 1),
  (2, 'SP-002', 1, 'Backend API Integration', 'Connect Acme services with external APIs', '2026-02-01', '2026-09-30', 'active', 1, 1),
  (3, 'SP-003', 2, 'Data Migration', 'Move retail catalog and orders to the new platform', '2026-03-01', '2026-07-31', 'active', 1, 1)
ON CONFLICT (sub_project_code) DO NOTHING;

SELECT setval('sub_projects_id_seq', GREATEST((SELECT MAX(id) FROM sub_projects), 3));

-- EMPLOYEES
INSERT INTO employees (
  id,
  employee_code,
  full_name,
  designation,
  total_experience,
  company_experience,
  resource_description,
  date_of_joining,
  status,
  created_by,
  updated_by
)
VALUES
  (2, 'EMP-002', 'Priya Sharma', 'Software Engineer', 3.5, 2.0, 'Frontend specialist assigned to Acme project.', '2025-10-15', 'active', 1, 1),
  (3, 'EMP-003', 'Rahul Verma', 'Backend Engineer', 5.0, 3.0, 'API and integration specialist.', '2025-09-01', 'active', 1, 1),
  (4, 'EMP-004', 'Sneha Patel', 'QA Engineer', 2.0, 1.5, 'Automation and regression testing.', '2026-02-10', 'active', 1, 1)
ON CONFLICT (employee_code) DO NOTHING;

SELECT setval('employees_id_seq', GREATEST((SELECT MAX(id) FROM employees), 4));

-- DUMMY USERS
INSERT INTO users (
  id,
  employee_id,
  email,
  password,
  role_id,
  status,
  created_by,
  updated_by
)
VALUES
  (2, 2, 'priya.sharma@rutportal.com', '$2b$12$a6Ex/FZQ1fMXPJdgk9qGduLv8bvvVK6F87xamgf2mC5m51ZxxXGmq', 4, 'active', 1, 1),
  (3, 3, 'rahul.verma@rutportal.com', '$2b$12$a6Ex/FZQ1fMXPJdgk9qGduLv8bvvVK6F87xamgf2mC5m51ZxxXGmq', 4, 'active', 1, 1),
  (4, 4, 'sneha.patel@rutportal.com', '$2b$12$a6Ex/FZQ1fMXPJdgk9qGduLv8bvvVK6F87xamgf2mC5m51ZxxXGmq', 2, 'active', 1, 1)
ON CONFLICT (email) DO NOTHING;

SELECT setval('users_id_seq', GREATEST((SELECT MAX(id) FROM users), 4));

-- SERVICE PO RESOURCES
INSERT INTO service_po_resources (id, service_po_id, employee_id, created_at)
VALUES
  (1, 1, 2, NOW()),
  (2, 1, 3, NOW()),
  (3, 2, 4, NOW())
ON CONFLICT (service_po_id, employee_id) DO NOTHING;

SELECT setval('service_po_resources_id_seq', GREATEST((SELECT MAX(id) FROM service_po_resources), 3));

-- TIMESHEETS
INSERT INTO timesheets (
  id,
  employee_id,
  service_po_id,
  sub_project_id,
  timesheet_date,
  hours_logged,
  created_by,
  updated_by
)
VALUES
  (1, 2, 1, 1, '2026-06-22', 8.0, 2, 2),
  (2, 3, 1, 2, '2026-06-22', 7.5, 3, 3),
  (3, 4, 2, 3, '2026-06-22', 8.0, 4, 4),
  (4, 2, 1, 1, '2026-06-23', 7.0, 2, 2),
  (5, 3, 1, 2, '2026-06-23', 8.0, 3, 3)
ON CONFLICT DO NOTHING;

SELECT setval('timesheets_id_seq', GREATEST((SELECT MAX(id) FROM timesheets), 5));

-- MONTHLY COSTS
INSERT INTO monthly_costs (
  id,
  employee_id,
  month_year,
  salary_cost,
  ops_cost,
  total_cost,
  billable_cost,
  created_by,
  updated_by
)
VALUES
  (1, 2, '2026-06', 250000.00, 12000.00, 262000.00, 150000.00, 1, 1),
  (2, 3, '2026-06', 300000.00, 15000.00, 315000.00, 180000.00, 1, 1),
  (3, 4, '2026-06', 200000.00, 9000.00, 209000.00, 120000.00, 1, 1)
ON CONFLICT DO NOTHING;

SELECT setval('monthly_costs_id_seq', GREATEST((SELECT MAX(id) FROM monthly_costs), 3));

-- NOTIFICATIONS
INSERT INTO notifications (id, user_id, title, message, type, is_read, created_at)
VALUES
  (1, 2, 'Timesheet Reminder', 'Please submit your weekly timesheet before Friday.', 'reminder', FALSE, NOW()),
  (2, 3, 'Project Kickoff', 'Backend integration kickoff scheduled for Monday.', 'info', FALSE, NOW())
ON CONFLICT DO NOTHING;

SELECT setval('notifications_id_seq', GREATEST((SELECT MAX(id) FROM notifications), 2));

-- USER SESSIONS
INSERT INTO user_sessions (id, user_id, refresh_token, expires_at, ip_address, user_agent, created_at)
VALUES
  (1, 2, 'dummy-refresh-token-001', '2026-12-31 23:59:59', '127.0.0.1', 'DummyAgent/1.0', NOW()),
  (2, 3, 'dummy-refresh-token-002', '2026-12-31 23:59:59', '127.0.0.1', 'DummyAgent/1.0', NOW())
ON CONFLICT (refresh_token) DO NOTHING;

SELECT setval('user_sessions_id_seq', GREATEST((SELECT MAX(id) FROM user_sessions), 2));

COMMIT;

-- =============================================================================
-- END OF SEEDS
-- =============================================================================
