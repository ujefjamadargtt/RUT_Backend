-- =============================================================================
-- Grant Manager the servicepo.manage_future_budget capability.
--
-- POST /api/v1/service-po-monthly-budgets (upsert) was gated to
-- 'Service PO Admin' only (see 20260836_seed_target_roles_and_capabilities.sql)
-- — Manager doesn't inherit it (inheritance runs the other way: Service PO
-- Admin inherits Manager, not vice versa), so a Manager mapped to a Service
-- PO (see servicePOMonthlyBudgetService.getAllowedServicePOIds) could view
-- the GET endpoints but got 403 FORBIDDEN on save. BU Admin already bypasses
-- every capability check via the senior-tier rule (hierarchy_rank <= 4, see
-- roleHierarchyService.isSeniorTier) and needs no grant here.
--
-- Looked up by role_name, not role_id — role IDs diverge between
-- environments (see database/README.md's prod/local note).
--
-- Safe to re-run (PRIMARY KEY (role_id, capability_key) + ON CONFLICT).
-- =============================================================================

BEGIN;

INSERT INTO role_capabilities (role_id, capability_key)
SELECT id, 'servicepo.manage_future_budget'
FROM roles
WHERE role_name = 'Manager'
ON CONFLICT (role_id, capability_key) DO NOTHING;

COMMIT;
