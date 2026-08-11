-- =============================================================================
-- RBAC Redesign — Phase 10: Primary/Secondary Manager support.
--
-- HR must be able to assign a mandatory Primary Manager and an optional
-- Secondary Manager per Employee at creation time (see Stage 3). Replaces
-- the old "exactly one Manager per Employee" invariant (single-column
-- unique index on employee_id) with "exactly one PRIMARY and at most one
-- SECONDARY Manager per Employee" (composite unique on employee_id +
-- mapping_type). Manager's own self-service "Map Employees" action
-- (src/services/managerEmployeeMappingService.js, Stage 3) reuses this same
-- table/column rather than a separate mechanism.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE manager_employee_mappings
  ADD COLUMN IF NOT EXISTS mapping_type VARCHAR(10) NOT NULL DEFAULT 'PRIMARY'
  CHECK (mapping_type IN ('PRIMARY', 'SECONDARY'));

DROP INDEX IF EXISTS uq_manager_employee_mappings_employee;

CREATE UNIQUE INDEX IF NOT EXISTS uq_manager_employee_mappings_employee_type
  ON manager_employee_mappings (employee_id, mapping_type);

COMMIT;
