-- =============================================================================
-- Employee-as-Identity Redesign — Phase 9d: entities gets an employee-keyed
-- admin column.
--
-- entities.entity_admin_user_id is nullable today (a freshly created Entity
-- starts with no admin) — entity_admin_employee_id mirrors that nullability.
-- Only non-NULL source values are backfilled; verification checks that
-- every non-NULL source produced a non-NULL target, not that every row has
-- one.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS entity_admin_employee_id INT REFERENCES employees (id);

UPDATE entities e
SET entity_admin_employee_id = u.employee_id
FROM users u
WHERE u.id = e.entity_admin_user_id
  AND e.entity_admin_employee_id IS NULL
  AND e.entity_admin_user_id IS NOT NULL;

DO $$
DECLARE v_missing INT;
BEGIN
  SELECT COUNT(*) INTO v_missing FROM entities
  WHERE entity_admin_user_id IS NOT NULL AND entity_admin_employee_id IS NULL;
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'add_entities_entity_admin_employee_id: % entities with an admin not backfilled', v_missing;
  END IF;
END $$;

COMMIT;
