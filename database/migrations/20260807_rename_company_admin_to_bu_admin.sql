-- =============================================================================
-- Renames the "Company Admin" role (seeded by
-- 20260729_seed_platform_roles.sql) to "BU Admin" (Business Unit Admin) — a
-- naming clarification only, no behavior change. role_form_mapping,
-- user_roles, and users.role_id all reference roles.id, never role_name, so
-- no other table needs updating.
--
-- Every literal "Company Admin" string reference in application code has
-- been updated to "BU Admin" alongside this migration:
--   - src/repositories/roleRepository.js (EXCLUDED_ROLE_NAMES — and note
--     "BU Admin" is now deliberately NOT excluded from the role list, so it
--     appears as a selectable role on the Role-Form mapping screen)
--   - src/middlewares/authorize.js (SUPERUSER_ROLES)
--   - src/services/companyService.js (roleRepository.findByName lookup)
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

UPDATE roles
SET role_name = 'BU Admin', updated_at = NOW()
WHERE role_name = 'Company Admin';

COMMIT;
