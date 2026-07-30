-- Seed role_form_mapping for the "Company Admin" role (id from roles.role_name),
-- introduced by the multi-tenancy retrofit's 20260729_seed_platform_roles.sql.
-- That migration created the role row itself but never seeded its sidebar
-- form access, so a Company Admin could log in successfully (valid JWT) but
-- received an empty `forms` array — the frontend sidebar showed nothing and
-- blocked all further steps.
--
-- Mirrors the pre-existing "Super Admin" business role's form set exactly
-- (same forms, same status), since that is the closest existing definition
-- of "full access" already validated in this codebase. Idempotent: safe to
-- re-run, and does nothing if Company Admin already has any mapping seeded.

INSERT INTO role_form_mapping (role_id, form_id, status, created_at, updated_at)
SELECT
  (SELECT id FROM roles WHERE role_name = 'Company Admin') AS role_id,
  rfm.form_id,
  rfm.status,
  NOW(),
  NOW()
FROM role_form_mapping rfm
WHERE rfm.role_id = (SELECT id FROM roles WHERE role_name = 'Super Admin')
ON CONFLICT (role_id, form_id) DO NOTHING;
