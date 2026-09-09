-- =============================================================================
-- Rename the "Service PO Admin" role to "Project Manager".
--
-- Pure rename of an EXISTING role row — role_id is unchanged, so every
-- FK-based table (role_capabilities, role_form_mapping, user_roles,
-- team_mappings, etc.) keeps working untouched; only the display name
-- itself changes. The role's capabilities/hierarchy/inheritance are
-- completely unaffected.
--
-- Also renames its companion Form Master screen ("Service PO Admin Master",
-- the BU/Project Admin screen for managing who holds this role) to
-- "Project Manager Master" — role_form_mapping references it by form_id
-- (FK), so no other row needs touching.
--
-- Note: an OLDER, unrelated legacy role was also once named "Project
-- Manager" (see 20260838_remap_legacy_roles.sql) and was retired/deleted by
-- 20260839_drop_obsolete_roles.sql during the RBAC redesign — that row no
-- longer exists, so there is no uq_roles_role_name collision here. This is
-- a deliberate reuse of that retired label for the current "Service PO
-- Admin" role, per product decision.
--
-- Deliberately does NOT touch service_pos.delivery_head_employee_id or
-- anything else named "Delivery Head" — that is a separate, per-Service-PO
-- staffing field/business attribute, not a role (see
-- src/services/employeeServicePOMappingService.js's
-- UNRESTRICTED_SERVICE_PO_ROLE_FRAGMENTS doc comment) — unaffected by this
-- role rename.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

UPDATE roles
SET role_name = 'Project Manager', updated_at = NOW()
WHERE role_name = 'Service PO Admin';

UPDATE form_master
SET form_name = 'Project Manager Master', updated_at = NOW()
WHERE module_name = 'Administration' AND form_name = 'Service PO Admin Master';

COMMIT;
