-- Rollback for 20260855_grant_manager_future_budget_capability.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.

BEGIN;

DELETE FROM role_capabilities
WHERE capability_key = 'servicepo.manage_future_budget'
  AND role_id IN (SELECT id FROM roles WHERE role_name = 'Manager');

COMMIT;
