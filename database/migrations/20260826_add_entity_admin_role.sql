-- =============================================================================
-- Adds the "Entity Admin" role — sits between Platform Admin and BU Admin.
-- Gated by the new src/middlewares/requireEntityAdmin.js (a direct role-name
-- check, deliberately NOT routed through authorize()'s SUPERUSER_ROLES
-- bypass, which would otherwise wrongly let BU Admin through).
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

INSERT INTO roles (role_name, permission, status, created_at, updated_at)
VALUES ('Entity Admin', 'Read & Write', 'active', NOW(), NOW())
ON CONFLICT (role_name) DO NOTHING;

COMMIT;
