-- =============================================================================
-- Rollback for 20260809_set_bu_admin_default_form_mapping.sql.
--
-- Restores BU Admin's mapping to mirror Super Admin's current mapping again
-- (the state 20260729_seed_company_admin_form_mapping.sql originally
-- produced), active/inactive status included.
--
-- NOTE: this restores a mirror of Super Admin's mapping as it exists AT
-- ROLLBACK TIME, not necessarily byte-for-byte what existed immediately
-- before the forward migration ran, since Super Admin's own mapping may have
-- changed in between. Also revert 20260807_restrict_admin_forms_to_platform_admin.sql
-- first if this rollback is meant to fully restore the pre-multi-tenancy-retrofit
-- baseline.
-- =============================================================================

BEGIN;

INSERT INTO role_form_mapping (role_id, form_id, status, created_at, updated_at)
SELECT
  (SELECT id FROM roles WHERE role_name = 'BU Admin'),
  rfm.form_id,
  rfm.status,
  NOW(),
  NOW()
FROM role_form_mapping rfm
WHERE rfm.role_id = (SELECT id FROM roles WHERE role_name = 'Super Admin')
ON CONFLICT (role_id, form_id) DO UPDATE SET status = EXCLUDED.status, updated_at = NOW();

COMMIT;
