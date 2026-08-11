-- =============================================================================
-- RBAC Redesign — Phase 2: role_capabilities.
--
-- Fine-grained business-action grants per role (e.g. 'bu.create_client',
-- 'servicepo.manage_team', 'manager.approve_timesheets'), replacing every
-- scattered ad hoc role-name string check in the codebase
-- (authorize.js's SUPERUSER_ROLES bypass, requireEntityAdmin.js's hardcoded
-- check, userService.js's BU_ADMIN_CREATABLE_ROLES array, etc.) with one
-- data-driven grant table. Combined with roles.inherits_role_id (see
-- 20260834), src/services/roleHierarchyService.js walks this table to
-- compute a role's *effective* capabilities — this table only ever holds
-- a role's OWN directly-granted capabilities, never a duplicated/inherited
-- copy.
--
-- Distinct from form_master/role_form_mapping, which is UI form-visibility
-- (unrelated to backend authorization) and is not inherited — see
-- 20260845_reseed_form_master_and_role_form_mapping.sql.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS role_capabilities (
  role_id INT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  capability_key VARCHAR(60) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (role_id, capability_key)
);

CREATE INDEX IF NOT EXISTS idx_role_capabilities_role_id ON role_capabilities (role_id);

COMMIT;
