-- Rollback for 20260900_unmap_team_lead_timesheet_approval_form.sql
-- Run manually if needed — the migration runner never picks this up
-- automatically (see migrationRunner.js's *_rollback.sql exclusion).

BEGIN;

UPDATE role_form_mapping
SET status = true, updated_at = NOW()
WHERE role_id = (SELECT id FROM roles WHERE role_name = 'Team Lead')
  AND form_id = (
    SELECT id FROM form_master WHERE module_name = 'Resources' AND form_name = 'Timesheet Approval'
  );

COMMIT;
