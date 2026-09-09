-- =============================================================================
-- Manager Monthly Work Log — new capability for the Manager role.
--
-- Lets a Manager fill in a Monthly Work Log on behalf of one of their own
-- mapped Employees (see managerMonthlyWorkLogService.js). Entries created
-- this way are auto-approved (status inserted directly as 'approved') and
-- restricted to the Employee's Main PO only (no hierarchy node selection).
--
-- Granted only to 'Manager' — 'Service PO Admin' and 'Project Admin'
-- inherit it automatically via inherits_role_id (see
-- 20260836_seed_target_roles_and_capabilities.sql), same as every other
-- manager.* capability.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

INSERT INTO role_capabilities (role_id, capability_key)
SELECT r.id, 'manager.fill_worklog'
FROM roles r
WHERE r.role_name = 'Manager'
ON CONFLICT (role_id, capability_key) DO NOTHING;

COMMIT;
