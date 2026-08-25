-- =============================================================================
-- Employee-as-Identity Redesign — Phase 9b: manager_servicepo_mappings gets
-- an employee-keyed manager column.
--
-- Same pattern as 20260872. This table is a genuine many-to-many
-- (manager_user_id, service_po_id) — verification confirms the pair-level
-- cardinality is unchanged after swapping in manager_employee_id.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE manager_servicepo_mappings
  ADD COLUMN IF NOT EXISTS manager_employee_id INT REFERENCES employees (id);

UPDATE manager_servicepo_mappings m
SET manager_employee_id = u.employee_id
FROM users u
WHERE u.id = m.manager_user_id
  AND m.manager_employee_id IS NULL;

DO $$
DECLARE
  v_null INT;
  v_pairs_before INT;
  v_pairs_after INT;
BEGIN
  SELECT COUNT(*) INTO v_null FROM manager_servicepo_mappings WHERE manager_employee_id IS NULL;
  IF v_null > 0 THEN
    RAISE EXCEPTION 'add_manager_servicepo_mappings_manager_employee_id: % rows have no manager_employee_id', v_null;
  END IF;

  SELECT COUNT(DISTINCT (manager_user_id, service_po_id)) INTO v_pairs_before FROM manager_servicepo_mappings;
  SELECT COUNT(DISTINCT (manager_employee_id, service_po_id)) INTO v_pairs_after FROM manager_servicepo_mappings;
  IF v_pairs_before <> v_pairs_after THEN
    RAISE EXCEPTION 'add_manager_servicepo_mappings_manager_employee_id: pair cardinality changed (% vs %)', v_pairs_before, v_pairs_after;
  END IF;
END $$;

COMMIT;
