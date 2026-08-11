-- Rollback for 20260826_add_entity_admin_role.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.
-- Only safe if no user/entity/role_form_mapping row references this role.

BEGIN;

DELETE FROM roles WHERE role_name = 'Entity Admin';

COMMIT;
