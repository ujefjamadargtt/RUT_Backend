-- =============================================================================
-- Adds the "Head Manager" role for the new Manager Mapping feature (view/
-- map/unmap Managers — see src/routes/managerMapping.routes.js). BU Admin
-- gets identical access with zero extra code: src/middlewares/authorize.js's
-- SUPERUSER_ROLES already bypasses every authorize([...]) check, so gating
-- these routes with authorize(['Head Manager']) alone already satisfies
-- "BU Admin must also be able to view/map/unmap Managers."
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

INSERT INTO roles (role_name, permission, status, created_at, updated_at)
VALUES ('Head Manager', 'Read & Write', 'active', NOW(), NOW())
ON CONFLICT (role_name) DO NOTHING;

COMMIT;
