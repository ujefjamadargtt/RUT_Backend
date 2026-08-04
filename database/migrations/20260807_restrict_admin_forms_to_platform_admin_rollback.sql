-- =============================================================================
-- Rollback for 20260807_restrict_admin_forms_to_platform_admin.sql.
--
-- Restores the pre-existing baseline from database/rbac_seed.sql: "Super
-- Admin" re-mapped (active) to the "Roles"/"Forms" admin screens, Platform
-- Admin's mapping to them reverted to inactive.
--
-- NOTE: any OTHER role that had a custom mapping to these two forms before
-- the forward migration ran cannot be automatically restored here — that
-- prior state wasn't recorded anywhere. Reapply those manually if needed.
-- Also revert rbacService.js's assertFormRoleMappingAllowed() guard if this
-- rollback is meant to fully undo the feature, not just the data.
-- =============================================================================

BEGIN;

INSERT INTO role_form_mapping (role_id, form_id, status, created_at, updated_at)
SELECT
  (SELECT id FROM roles WHERE role_name = 'Super Admin'),
  fm.id,
  true,
  NOW(),
  NOW()
FROM form_master fm
WHERE fm.module_name = 'Administration' AND fm.form_name IN ('Roles', 'Forms')
ON CONFLICT (role_id, form_id) DO UPDATE SET status = true, updated_at = NOW();

UPDATE role_form_mapping
SET status = false, updated_at = NOW()
WHERE form_id IN (
    SELECT id FROM form_master WHERE module_name = 'Administration' AND form_name IN ('Roles', 'Forms')
  )
  AND role_id = (SELECT id FROM roles WHERE role_name = 'Platform Admin');

COMMIT;
