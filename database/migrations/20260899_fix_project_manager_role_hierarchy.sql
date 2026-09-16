-- =============================================================================
-- Backfill the "Project Manager" role's hierarchy_rank/inherits_role_id.
--
-- 20260836_seed_target_roles_and_capabilities.sql intended "Service PO
-- Admin" to get hierarchy_rank = 6 and inherits_role_id = Manager's (now
-- "Team Lead"'s) id, then be renamed to "Project Manager" by
-- 20260896_rename_service_po_admin_role_to_project_manager.sql. On at least
-- one environment, the role row that actually exists today is named
-- "Project Manager" already — its rank/inheritance UPDATE (which targets
-- WHERE role_name = 'Service PO Admin') never matched it and both columns
-- were left NULL. Confirmed by symptom: a Project Manager-only session
-- (Role-Based Login scopes a session to its one selected role — see
-- auth.js's `activeRoleId` handling) gets 403 FORBIDDEN on
-- manager.view_mapped_employees (GET /my-team/employees) despite the design
-- explicitly intending Project Manager to inherit every Manager/Team Lead
-- capability, and resolves to hierarchyRank NULL instead of 6 anywhere rank
-- is checked directly (e.g. company.routes.js's allowCompanyListing).
-- 20260898_grant_client_project_servicepo_capabilities_to_project_manager.sql
-- already assumes this inheritance is live ("Project Admin (rank 5) already
-- inherits every Project Manager (rank 6) capability via inherits_role_id")
-- — this migration makes that assumption true.
--
-- Guarded (`AND hierarchy_rank IS NULL`) so it's a no-op wherever the rank/
-- inheritance is already correctly set (e.g. an environment where the
-- rename path above worked as designed) or where the source row hasn't
-- been renamed away from "Service PO Admin" yet (nothing to fix there —
-- 20260836/20260896 already handle that ordering).
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

UPDATE roles
SET hierarchy_rank = 6,
    inherits_role_id = (SELECT id FROM roles WHERE role_name = 'Team Lead'),
    updated_at = NOW()
WHERE role_name = 'Project Manager'
  AND hierarchy_rank IS NULL;

COMMIT;
