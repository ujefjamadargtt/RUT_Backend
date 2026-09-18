-- Timesheet Approval redesign — Team Lead is removed from the Timesheet
-- Approval WORKFLOW: unmap the "Timesheet Approval" form/menu item from the
-- Team Lead role (role_form_mapping soft-toggle, status=false — never
-- deletes the row, same convention as
-- 20260845_reseed_form_master_and_role_form_mapping.sql).
--
-- Deliberately does NOT touch Team Lead's manager.approve_timesheets
-- capability (role_capabilities) or manager_employee_mappings — Team Lead's
-- backend approval logic/access must remain exactly as it is; only the UI
-- entry point is removed. Project Manager approval is unaffected by this
-- migration (it's a separate role_form_mapping row and, since
-- 20260836_seed_target_roles_and_capabilities.sql, its own direct
-- servicepo.approve_timesheets/servicepo.view_mapped_employees capabilities
-- — see the application-layer changes in the same change set as this
-- migration).
--
-- Safe to re-run (idempotent — only flips rows currently status=true).

BEGIN;

UPDATE role_form_mapping
SET status = false, updated_at = NOW()
WHERE status = true
  AND role_id = (SELECT id FROM roles WHERE role_name = 'Team Lead')
  AND form_id = (
    SELECT id FROM form_master WHERE module_name = 'Resources' AND form_name = 'Timesheet Approval'
  );

COMMIT;
