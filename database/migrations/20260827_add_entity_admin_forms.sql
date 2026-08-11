-- =============================================================================
-- New form_master rows for the two screens Entity Admin is allowed to see —
-- a new "Entity Management" module, distinct from the existing
-- "Administration" module (Roles/Forms/User Role Mapping/Role Form Mapping
-- are company-internal admin screens; Entity Master/BU Admin Master are
-- platform/entity-tier screens Entity Admin needs instead).
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

INSERT INTO form_master (module_name, form_name, status, created_at, updated_at)
VALUES
  ('Entity Management', 'Entity Master', 'active', NOW(), NOW()),
  ('Entity Management', 'BU Admin Master', 'active', NOW(), NOW())
ON CONFLICT (module_name, form_name) DO NOTHING;

COMMIT;
