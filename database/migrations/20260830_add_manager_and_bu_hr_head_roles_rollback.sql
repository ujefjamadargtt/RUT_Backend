-- Rollback for 20260830_add_manager_and_bu_hr_head_roles.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.
-- Only safe if no user/mapping row references either role.

BEGIN;

DELETE FROM roles WHERE role_name IN ('Manager', 'BU HR Head');

COMMIT;
