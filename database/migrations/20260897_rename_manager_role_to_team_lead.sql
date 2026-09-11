-- =============================================================================
-- Rename the "Manager" role to "Team Lead".
--
-- Pure rename of an EXISTING role row — role_id is unchanged, so every
-- FK-based table (role_capabilities, role_form_mapping, employee_roles,
-- manager_employee_mappings, team_mappings, etc.) keeps working untouched;
-- only the display name itself changes. The role's capabilities/hierarchy/
-- inheritance are completely unaffected.
--
-- Deliberately does NOT touch:
--   - "Project Manager" — a DIFFERENT role (own row, own hierarchy_rank);
--     this WHERE clause only ever matches the exact 'Manager' row.
--   - manager_employee_mappings / manager_user_id / "manager" association
--     aliases (ManagerEmployeeMapping, ManagerServicePOMapping, TeamMapping)
--     — these are generic domain/table names describing the
--     "who-manages-whom" relationship itself, not the role's display name;
--     they are unaffected by this rename, same precedent as the
--     "Service PO Admin" -> "Project Manager" rename
--     (20260896_rename_service_po_admin_role_to_project_manager.sql), which
--     left servicepo.* capability keys / ManagerServicePOMapping / etc.
--     untouched too.
--   - role_capabilities' `manager.*` capability keys — internal identifiers,
--     not the role's display name.
--   - form_master — no "Manager Master" form exists (only "Project Manager
--     Master", a different form entirely); nothing to rename here.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

UPDATE roles
SET role_name = 'Team Lead', updated_at = NOW()
WHERE role_name = 'Manager';

COMMIT;
