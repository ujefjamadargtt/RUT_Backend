-- Rollback for 20260894_add_manager_fill_worklog_capability.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.

BEGIN;

DELETE FROM role_capabilities
WHERE capability_key = 'manager.fill_worklog'
  AND role_id IN (SELECT id FROM roles WHERE role_name = 'Manager');

COMMIT;
