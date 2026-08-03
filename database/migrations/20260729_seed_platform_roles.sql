-- =============================================================================
-- Multi-Tenancy Retrofit — Phase 1b: add the two new role definitions this
-- retrofit introduces. Role definitions stay GLOBAL (per the retrofit spec),
-- exactly like the existing HR/Finance/Division Head/Project Manager/
-- Management rows.
--
-- Deliberately named "Platform Admin", NOT "Super Admin" — this database
-- already has a business-level "Super Admin" role (id 6, seeded by
-- database/rbac_seed.sql) that is assigned to a real existing user and
-- carries real role_form_mapping grants (Dashboard, Reports, Clients,
-- Employees, etc. — see rbac_seed.sql). Reusing that name/row for the new
-- platform-level operator would either (a) silently hand the new platform
-- role all of the old role's existing business-data access, directly
-- contradicting "Super Admin must not access Dashboard/Reports/Clients/...",
-- or (b) require stripping the old role's mappings, which would break the
-- existing user already assigned to it (user_roles row (41, 1, 6) in
-- rbac_seed.sql). "Platform Admin" avoids both problems.
--
-- This role exists ONLY so the platform admin user satisfies the existing
-- authenticate() middleware's "must have at least one active role" check
-- (src/middlewares/auth.js) — actual gating of platform-only endpoints
-- (POST/GET/PATCH /api/v1/companies) is done by the dedicated
-- requirePlatformAdmin middleware checking users.is_platform_admin, NOT by
-- this role name. No role_form_mapping rows are ever created for this role.
-- =============================================================================

BEGIN;

-- created_at/updated_at set explicitly to NOW() rather than left to a
-- DB-level DEFAULT — see 20260804_backfill_default_service_types.sql's header
-- comment for why that assumption doesn't reliably hold across environments.
INSERT INTO roles (role_name, permission, status, created_at, updated_at)
VALUES ('Platform Admin', 'Read & Write', 'active', NOW(), NOW())
ON CONFLICT (role_name) DO NOTHING;

INSERT INTO roles (role_name, permission, status, created_at, updated_at)
VALUES ('Company Admin', 'Read & Write', 'active', NOW(), NOW())
ON CONFLICT (role_name) DO NOTHING;

COMMIT;
