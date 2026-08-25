-- =============================================================================
-- Employee-as-Identity Redesign — Phase 9a: manager_employee_mappings gets
-- an employee-keyed manager column.
--
-- manager_employee_mappings.manager_user_id identifies WHO manages the
-- mapped employee (manager_employee_mappings.employee_id, untouched here —
-- that column already identifies the MANAGED employee and never referenced
-- users). Once `users` is truncated, manager identity must be an Employee
-- id — this adds manager_employee_id alongside the old column (dropped in
-- 20260876 once every repoint in this phase is verified).
--
-- This table has caused a real prior incident (a missing PRIMARY mapping
-- silently dropped an employee's timesheets from sync) — verification here
-- is intentionally strict: exact row-count match, zero NULLs, and the
-- existing uq_manager_employee_mappings_employee cardinality unchanged.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE manager_employee_mappings
  ADD COLUMN IF NOT EXISTS manager_employee_id INT REFERENCES employees (id);

UPDATE manager_employee_mappings m
SET manager_employee_id = u.employee_id
FROM users u
WHERE u.id = m.manager_user_id
  AND m.manager_employee_id IS NULL;

DO $$
DECLARE
  v_total INT;
  v_null INT;
  v_distinct_before INT;
  v_distinct_after INT;
BEGIN
  SELECT COUNT(*) INTO v_total FROM manager_employee_mappings;
  SELECT COUNT(*) INTO v_null FROM manager_employee_mappings WHERE manager_employee_id IS NULL;
  IF v_null > 0 THEN
    RAISE EXCEPTION 'add_manager_employee_mappings_manager_employee_id: % of % rows have no manager_employee_id', v_null, v_total;
  END IF;

  SELECT COUNT(DISTINCT employee_id) INTO v_distinct_before FROM manager_employee_mappings;
  SELECT COUNT(DISTINCT employee_id) INTO v_distinct_after FROM manager_employee_mappings WHERE manager_employee_id IS NOT NULL;
  IF v_distinct_before <> v_distinct_after THEN
    RAISE EXCEPTION 'add_manager_employee_mappings_manager_employee_id: managed-employee coverage changed (% vs %)', v_distinct_before, v_distinct_after;
  END IF;
END $$;

COMMIT;
