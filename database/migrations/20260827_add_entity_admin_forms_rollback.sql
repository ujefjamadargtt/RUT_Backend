-- Rollback for 20260827_add_entity_admin_forms.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.
-- Must be run BEFORE rolling back 20260828 (which maps role_form_mapping
-- rows to these forms) — actually role_form_mapping rows referencing a
-- deleted form_id would violate the FK, so delete those first.

BEGIN;

DELETE FROM role_form_mapping
  WHERE form_id IN (
    SELECT id FROM form_master WHERE module_name = 'Entity Management' AND form_name IN ('Entity Master', 'BU Admin Master')
  );

DELETE FROM form_master WHERE module_name = 'Entity Management' AND form_name IN ('Entity Master', 'BU Admin Master');

COMMIT;
