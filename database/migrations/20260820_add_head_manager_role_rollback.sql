-- Rollback for 20260820_add_head_manager_role.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.
-- Only safe if no user/role_form_mapping/manager_mappings row references
-- this role yet.

BEGIN;

DELETE FROM roles WHERE role_name = 'Head Manager';

COMMIT;
