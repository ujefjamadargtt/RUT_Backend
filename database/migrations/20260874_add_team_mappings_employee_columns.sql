-- =============================================================================
-- Employee-as-Identity Redesign — Phase 9c: team_mappings gets
-- employee-keyed manager + service_po_admin columns.
--
-- team_mappings.manager_user_id and .service_po_admin_user_id both identify
-- Users today (Service PO Admin -> Manager team roster, one row per
-- Manager — see uq_team_mappings_manager on manager_user_id alone). Adds
-- both employee-keyed equivalents; verification re-checks that same
-- one-Manager-per-team cardinality survives the swap.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE team_mappings
  ADD COLUMN IF NOT EXISTS manager_employee_id INT REFERENCES employees (id),
  ADD COLUMN IF NOT EXISTS service_po_admin_employee_id INT REFERENCES employees (id);

UPDATE team_mappings t
SET manager_employee_id = u.employee_id
FROM users u
WHERE u.id = t.manager_user_id
  AND t.manager_employee_id IS NULL;

UPDATE team_mappings t
SET service_po_admin_employee_id = u.employee_id
FROM users u
WHERE u.id = t.service_po_admin_user_id
  AND t.service_po_admin_employee_id IS NULL;

DO $$
DECLARE
  v_null INT;
  v_distinct_before INT;
  v_distinct_after INT;
BEGIN
  SELECT COUNT(*) INTO v_null FROM team_mappings
  WHERE manager_employee_id IS NULL OR service_po_admin_employee_id IS NULL;
  IF v_null > 0 THEN
    RAISE EXCEPTION 'add_team_mappings_employee_columns: % rows missing an employee-keyed column', v_null;
  END IF;

  SELECT COUNT(DISTINCT manager_user_id) INTO v_distinct_before FROM team_mappings;
  SELECT COUNT(DISTINCT manager_employee_id) INTO v_distinct_after FROM team_mappings;
  IF v_distinct_before <> v_distinct_after THEN
    RAISE EXCEPTION 'add_team_mappings_employee_columns: one-manager-per-team cardinality changed (% vs %)', v_distinct_before, v_distinct_after;
  END IF;
END $$;

COMMIT;
