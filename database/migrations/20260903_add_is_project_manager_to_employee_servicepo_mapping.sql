-- =============================================================================
-- Project Manager <-> Service PO explicit assignment.
--
-- Previously, an Employee holding the "Project Manager" role was treated as
-- the Project Manager of EVERY Service PO they happened to be mapped to
-- (employee_servicepo_mapping, any active row) — see
-- src/services/employeeServicePOMappingService.js's old
-- getProjectManagerServicePOIds()/getProjectManagersForServicePOs(). That
-- conflated two different things: "this Employee is mapped to this Service
-- PO" and "this Employee is the Project Manager FOR this Service PO."
--
-- This column makes the second concept explicit and independent of the
-- first: is_project_manager = false means a plain employee mapping (the
-- default — every existing row backfills to false, so no existing mapping
-- is silently reinterpreted as a PM assignment); is_project_manager = true
-- means this SAME mapping row also carries Project Manager/approver
-- authority for this one Service PO. Application-layer validation (not a
-- DB constraint, since it depends on the employee's CURRENT role set in
-- employee_roles) enforces that only an Employee currently holding the
-- Project Manager role may have a row with is_project_manager = true — see
-- employeeServicePOMappingService.js's assign()/saveEmployeeServicePOMappings()/
-- setMappingProjectManagerFlag().
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE employee_servicepo_mapping
  ADD COLUMN IF NOT EXISTS is_project_manager BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_employee_servicepo_mapping_is_project_manager
  ON employee_servicepo_mapping (is_project_manager);

COMMIT;
