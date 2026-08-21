-- Rollback for 20260862_seed_bu_head_capabilities_and_forms.sql
-- Run BEFORE rolling back 20260861 (the role row itself), since FK
-- constraints on role_capabilities.role_id / role_form_mapping.role_id
-- would otherwise block deleting the BU Head role row while these remain.

BEGIN;

DELETE FROM role_capabilities
WHERE role_id = (SELECT id FROM roles WHERE role_name = 'BU Head');

DELETE FROM role_form_mapping
WHERE role_id = (SELECT id FROM roles WHERE role_name = 'BU Head');

COMMIT;
