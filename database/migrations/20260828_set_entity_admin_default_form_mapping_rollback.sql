-- Rollback for 20260828_set_entity_admin_default_form_mapping.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.

BEGIN;

DELETE FROM role_form_mapping
  WHERE role_id = (SELECT id FROM roles WHERE role_name = 'Entity Admin');

COMMIT;
