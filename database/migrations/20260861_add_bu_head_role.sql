-- =============================================================================
-- BU Head — new, purely additive role.
--
-- BU Head is a peer of BU Admin in terms of access (same forms/capabilities —
-- see 20260862_seed_bu_head_capabilities_and_forms.sql), but is scoped to a
-- SET of existing Companies ("BUs") rather than the single company_id a BU
-- Admin belongs to (see bu_head_company_mappings,
-- 20260863_create_bu_head_company_mappings.sql). It never creates a Company
-- (that stays Admin/Entity Admin's job via companyService.createWithAdmin).
--
-- hierarchy_rank / inherits_role_id are left NULL — the same "parallel
-- branch" shape already used for HR (see
-- 20260836_seed_target_roles_and_capabilities.sql) — rather than reusing BU
-- Admin's hierarchy_rank = 4. That would silently pull BU Head into
-- SENIOR_BYPASS_MAX_RANK's capability bypass (src/services/
-- roleHierarchyService.js) and resolveCompany.js's single-company branch,
-- neither of which is what a multi-BU role needs. BU Head's effective access
-- is instead 100% capability/form-driven (copied 1:1 from BU Admin), and its
-- company scope is resolved per-request against bu_head_company_mappings
-- (src/middlewares/resolveCompany.js).
--
-- is_system = false: unlike the original 9 seeded roles, BU Head is not
-- protected from rename/delete by the dynamic Role CRUD — it is a normal,
-- editable role like any other added after the RBAC redesign.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

INSERT INTO roles (role_name, permission, status, is_system, hierarchy_rank, inherits_role_id, created_at, updated_at)
VALUES ('BU Head', 'Read & Write', 'active', false, NULL, NULL, NOW(), NOW())
ON CONFLICT (role_name) DO NOTHING;

COMMIT;
