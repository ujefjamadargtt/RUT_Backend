-- Rollback for 20260896_rename_service_po_admin_role_to_project_manager.sql
-- Run manually if needed — the migration runner never picks this up
-- automatically (see migrationRunner.js's *_rollback.sql exclusion).

BEGIN;

UPDATE roles
SET role_name = 'Service PO Admin', updated_at = NOW()
WHERE role_name = 'Project Manager';

UPDATE form_master
SET form_name = 'Service PO Admin Master', updated_at = NOW()
WHERE module_name = 'Administration' AND form_name = 'Project Manager Master';

COMMIT;
