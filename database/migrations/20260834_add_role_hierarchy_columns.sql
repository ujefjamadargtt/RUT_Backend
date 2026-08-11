-- =============================================================================
-- RBAC Redesign — Phase 1: role hierarchy columns.
--
-- Adds the three columns the new permission-inheritance engine needs on
-- `roles`:
--   - hierarchy_rank: 1 (Platform Admin) .. 8 (Employee) for the admin chain;
--     NULL for roles outside the chain (HR is a parallel branch).
--   - inherits_role_id: self-referencing FK — "this role's users also get
--     every capability granted to the referenced role." Only set for the
--     two edges the spec actually states (Service PO Admin <- Manager,
--     Project Admin <- Service PO Admin); every other role's capability
--     list is self-contained, so this stays NULL for them.
--   - is_system: true for the 9 seeded roles this redesign defines — blocks
--     deletion/rename via the dynamic Role CRUD (src/services/roleService.js).
--
-- See 20260836_seed_target_roles_and_capabilities.sql for the actual values.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE roles ADD COLUMN IF NOT EXISTS hierarchy_rank SMALLINT;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS inherits_role_id INT REFERENCES roles (id);
ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_roles_hierarchy_rank ON roles (hierarchy_rank);

COMMIT;
