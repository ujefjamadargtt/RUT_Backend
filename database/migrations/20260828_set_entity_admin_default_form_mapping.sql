-- =============================================================================
-- Default form mapping for the Entity Admin role — mirrors
-- 20260809_set_bu_admin_default_form_mapping.sql's exact pattern: upsert-
-- active exactly the allowed forms, then explicitly deactivate every other
-- form mapping for this role (defends against any future form_master row
-- silently becoming visible to Entity Admin by default).
--
-- Entity Admin must see ONLY Entity Master + BU Admin Master — nothing
-- else (no User Master, Employee, Work Log, Timesheets, Reports,
-- Dashboard, Service PO, Monthly Cost, Role Master, Form Master, or any
-- other admin functionality).
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

INSERT INTO role_form_mapping (role_id, form_id, status, created_at, updated_at)
SELECT
  (SELECT id FROM roles WHERE role_name = 'Entity Admin'),
  fm.id,
  true,
  NOW(),
  NOW()
FROM form_master fm
WHERE (fm.module_name, fm.form_name) IN (
  ('Entity Management', 'Entity Master'),
  ('Entity Management', 'BU Admin Master')
)
ON CONFLICT (role_id, form_id) DO UPDATE SET status = true, updated_at = NOW();

UPDATE role_form_mapping
SET status = false, updated_at = NOW()
WHERE status = true
  AND role_id = (SELECT id FROM roles WHERE role_name = 'Entity Admin')
  AND form_id IN (
    SELECT fm.id FROM form_master fm
    WHERE (fm.module_name, fm.form_name) NOT IN (
      ('Entity Management', 'Entity Master'),
      ('Entity Management', 'BU Admin Master')
    )
  );

COMMIT;
