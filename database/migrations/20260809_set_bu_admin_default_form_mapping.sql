-- =============================================================================
-- Sets BU Admin's (renamed from "Company Admin" — see
-- 20260807_rename_company_admin_to_bu_admin.sql) default form access to
-- exactly the set curated in the local/dev environment, instead of the full
-- mirror-of-"Super Admin" set that 20260729_seed_company_admin_form_mapping.sql
-- originally seeded.
--
-- That seed migration copied every one of Super Admin's form mappings verbatim
-- onto Company Admin, so any environment where it already ran (including a
-- fresh environment applying it for the first time) ends up with BU Admin
-- mapped to every admin-facing screen Super Admin has. In local, several of
-- those were deliberately unmapped afterward through the Role-Form Mapping
-- screen: "Role Form Mapping", "Service Categories", "Service Types", and
-- "Sub-Projects" — on top of "Roles"/"Forms", which
-- 20260807_restrict_admin_forms_to_platform_admin.sql already restricts
-- platform-wide. This migration replays that same curation as data, so every
-- environment converges on the same default regardless of when the mirror
-- seed ran or what Super Admin's form set looked like at the time.
--
-- Active (status = true) for BU Admin by default: Dashboard, AI Insights,
-- Employees, Users, Clients, Service POs, Timesheets, Monthly Costs, PO vs
-- Resource, Service PO Summary, Monthly Utilization, Resource Allocation,
-- Resource Project Utilization.
--
-- Explicitly NOT active for BU Admin: Forms, Roles, Role Form Mapping, User
-- Role Mapping, Service Categories, Service Types, Sub-Projects. Existing
-- inactive rows are soft-unmapped (status = false), never deleted, matching
-- this table's existing convention. No row is created for a form outside the
-- active set that doesn't already have one (e.g. "User Role Mapping"), so
-- this never grows BU Admin's mapping beyond what local already has.
--
-- Every other role's mappings are untouched.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

INSERT INTO role_form_mapping (role_id, form_id, status, created_at, updated_at)
SELECT
  (SELECT id FROM roles WHERE role_name = 'BU Admin'),
  fm.id,
  true,
  NOW(),
  NOW()
FROM form_master fm
WHERE (fm.module_name, fm.form_name) IN (
  ('Core', 'Dashboard'),
  ('Core', 'AI Insights'),
  ('People', 'Employees'),
  ('People', 'Users'),
  ('Business', 'Clients'),
  ('Business', 'Service POs'),
  ('Resources', 'Timesheets'),
  ('Resources', 'Monthly Costs'),
  ('Reports', 'PO vs Resource'),
  ('Reports', 'Service PO Summary'),
  ('Reports', 'Monthly Utilization'),
  ('Reports', 'Resource Allocation'),
  ('Reports', 'Resource Project Utilization')
)
ON CONFLICT (role_id, form_id) DO UPDATE SET status = true, updated_at = NOW();

UPDATE role_form_mapping
SET status = false, updated_at = NOW()
WHERE status = true
  AND role_id = (SELECT id FROM roles WHERE role_name = 'BU Admin')
  AND form_id IN (
    SELECT fm.id FROM form_master fm
    WHERE (fm.module_name, fm.form_name) NOT IN (
      ('Core', 'Dashboard'),
      ('Core', 'AI Insights'),
      ('People', 'Employees'),
      ('People', 'Users'),
      ('Business', 'Clients'),
      ('Business', 'Service POs'),
      ('Resources', 'Timesheets'),
      ('Resources', 'Monthly Costs'),
      ('Reports', 'PO vs Resource'),
      ('Reports', 'Service PO Summary'),
      ('Reports', 'Monthly Utilization'),
      ('Reports', 'Resource Allocation'),
      ('Reports', 'Resource Project Utilization')
    )
  );

COMMIT;
