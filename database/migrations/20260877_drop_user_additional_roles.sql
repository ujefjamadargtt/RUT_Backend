-- =============================================================================
-- Employee-as-Identity Redesign — Phase 11: retire user_additional_roles.
--
-- Fully superseded by employee_roles (the sole source of an employee's
-- roles going forward). Re-verifies every row is represented there before
-- dropping, since this is destructive.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

DO $$
DECLARE v_missing INT;
BEGIN
  SELECT COUNT(*) INTO v_missing FROM user_additional_roles uar
  JOIN users u ON u.id = uar.user_id
  WHERE NOT EXISTS (
    SELECT 1 FROM employee_roles er WHERE er.employee_id = u.employee_id AND er.role_id = uar.role_id
  );
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'drop_user_additional_roles: % additional roles still not covered by employee_roles', v_missing;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_user_additional_roles_updated_at ON user_additional_roles;
DROP TABLE IF EXISTS user_additional_roles;

COMMIT;
