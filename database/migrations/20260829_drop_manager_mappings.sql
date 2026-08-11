-- =============================================================================
-- Drops the manager_mappings table — the flat "any User maps any other
-- User under themselves" design built earlier turned out not to match the
-- real requirement (a strict BU Admin -> Head Manager -> Manager ->
-- Employee/ServicePO delegation chain). Replaced by head_manager_mappings,
-- manager_employee_mappings, and manager_servicepo_mappings (see the
-- following migrations). The one existing row at drop time has no valid
-- translation into the new model.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

DROP TRIGGER IF EXISTS trg_manager_mappings_updated_at ON manager_mappings;
DROP TABLE IF EXISTS manager_mappings;

COMMIT;
