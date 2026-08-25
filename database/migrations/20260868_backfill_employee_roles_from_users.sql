-- =============================================================================
-- Employee-as-Identity Redesign — Phase 5: backfill employee_roles.
--
-- Copies every User's primary role (users.role_id) and every active
-- additional role (user_additional_roles) onto that User's linked Employee
-- (guaranteed to exist after 20260867, and guaranteed unique per Employee
-- per uq_users_employee_id). Hard-fails if any source row wasn't copied —
-- every later step assumes full coverage before touching `users`.
--
-- Safe to re-run (ON CONFLICT DO NOTHING).
-- =============================================================================

BEGIN;

INSERT INTO employee_roles (employee_id, role_id, status, created_by, updated_by)
SELECT u.employee_id, u.role_id,
       CASE WHEN u.is_deleted OR u.status = 'inactive' THEN 'inactive' ELSE 'active' END,
       u.created_by, u.updated_by
FROM users u
WHERE u.role_id IS NOT NULL
ON CONFLICT (employee_id, role_id) DO NOTHING;

INSERT INTO employee_roles (employee_id, role_id, status, created_by, updated_by)
SELECT u.employee_id, uar.role_id,
       CASE WHEN u.is_deleted OR u.status = 'inactive' THEN 'inactive' ELSE 'active' END,
       uar.created_by, uar.updated_by
FROM user_additional_roles uar
JOIN users u ON u.id = uar.user_id
ON CONFLICT (employee_id, role_id) DO NOTHING;

DO $$
DECLARE v_missing INT;
BEGIN
  SELECT COUNT(*) INTO v_missing FROM users u
  WHERE u.role_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM employee_roles er WHERE er.employee_id = u.employee_id AND er.role_id = u.role_id
  );
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'backfill_employee_roles_from_users: % primary user roles not backfilled', v_missing;
  END IF;

  SELECT COUNT(*) INTO v_missing FROM user_additional_roles uar
  JOIN users u ON u.id = uar.user_id
  WHERE NOT EXISTS (
    SELECT 1 FROM employee_roles er WHERE er.employee_id = u.employee_id AND er.role_id = uar.role_id
  );
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'backfill_employee_roles_from_users: % additional user roles not backfilled', v_missing;
  END IF;
END $$;

COMMIT;
