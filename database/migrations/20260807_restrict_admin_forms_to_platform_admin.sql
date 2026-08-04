-- =============================================================================
-- Restrict the "Roles" and "Forms" admin screens (form_master rows seeded in
-- database/rbac_seed.sql, module 'Administration') to the "Platform Admin"
-- role ONLY. These two screens ARE the RBAC configuration surface itself —
-- they manage which roles and forms exist system-wide — so access is being
-- tightened to the platform operator alone. Previously "Super Admin" (and
-- potentially other roles) had these mapped via rbac_seed.sql.
--
-- Soft-unmaps (status = false, never deletes — matches this table's existing
-- convention, see 20260723_add_role_form_mapping_status.sql) every OTHER
-- role's mapping to these two forms, then ensures Platform Admin has an
-- active mapping to both.
--
-- This is a deliberate, narrow exception to 20260729_seed_platform_roles.sql's
-- "no role_form_mapping rows are ever created for [Platform Admin]" — that
-- statement still holds for every OTHER form; only "Roles" and "Forms" are
-- carved out here. Going forward, this scope is also enforced at the
-- application layer — see rbacService.js's assertFormRoleMappingAllowed(),
-- called from mapForm()/replaceRoleFormMappings() — so these two forms can't
-- drift back onto another role, or be unmapped from Platform Admin, through
-- the Role-Form Mapping screen/API.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

UPDATE role_form_mapping
SET status = false, updated_at = NOW()
WHERE status = true
  AND form_id IN (
    SELECT id FROM form_master WHERE module_name = 'Administration' AND form_name IN ('Roles', 'Forms')
  )
  AND role_id <> (SELECT id FROM roles WHERE role_name = 'Platform Admin');

INSERT INTO role_form_mapping (role_id, form_id, status, created_at, updated_at)
SELECT
  (SELECT id FROM roles WHERE role_name = 'Platform Admin'),
  fm.id,
  true,
  NOW(),
  NOW()
FROM form_master fm
WHERE fm.module_name = 'Administration' AND fm.form_name IN ('Roles', 'Forms')
ON CONFLICT (role_id, form_id) DO UPDATE SET status = true, updated_at = NOW();

COMMIT;
