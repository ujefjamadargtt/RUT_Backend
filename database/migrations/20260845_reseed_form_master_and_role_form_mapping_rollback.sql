-- Rollback for 20260845_reseed_form_master_and_role_form_mapping.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.
-- Deactivates the mappings this migration created; does not restore
-- whatever role_form_mapping state existed before it ran (not recoverable
-- from here) and does not delete the new form_master rows (other role
-- mappings inserted later may reference them).

BEGIN;

UPDATE role_form_mapping
SET status = false, updated_at = NOW()
WHERE role_id IN (
  SELECT id FROM roles WHERE role_name IN
    ('Admin', 'Entity Admin', 'BU Admin', 'Project Admin', 'Service PO Admin', 'Manager', 'Employee', 'HR')
);

COMMIT;
