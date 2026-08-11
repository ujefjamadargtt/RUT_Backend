-- =============================================================================
-- RBAC Redesign — Phase 8: drop users.is_platform_admin.
--
-- This boolean was a THIRD, independent gating signal alongside role names
-- (see requireEntityAdmin.js's hardcoded string check and authorize.js's
-- SUPERUSER_ROLES bypass) — now fully superseded by `roles.hierarchy_rank = 1`
-- (Platform Admin), the single source of truth going forward.
--
-- Also adds a partial unique index enforcing "at most one User per
-- Employee" — the new Employee-creation flow always creates exactly one
-- linked User, and nothing else should ever create a second.
--
-- Pre-existing duplicate employee_id links (found in practice — two
-- different User accounts pointed at the same Employee row) are resolved
-- first, deterministically: for each duplicated employee_id, keep the link
-- on the HR-role user if one of the duplicates holds that role (matches the
-- decision made for the first such case found), else keep the earliest-
-- created user; every other duplicate has its employee_id cleared (it
-- remains a perfectly normal admin-tier User account with no linked
-- Employee). Each clear is logged via RAISE NOTICE so it's visible in the
-- deploy log, not silent.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE users DROP COLUMN IF EXISTS is_platform_admin;

DO $$
DECLARE
  v_emp INT;
  v_keep_id INT;
  v_cleared RECORD;
BEGIN
  FOR v_emp IN
    SELECT employee_id FROM users WHERE employee_id IS NOT NULL GROUP BY employee_id HAVING COUNT(*) > 1
  LOOP
    SELECT u.id INTO v_keep_id
    FROM users u
    LEFT JOIN roles r ON r.id = u.role_id
    WHERE u.employee_id = v_emp
    ORDER BY (r.role_name = 'HR') DESC, u.created_at ASC
    LIMIT 1;

    FOR v_cleared IN
      SELECT id, email FROM users WHERE employee_id = v_emp AND id <> v_keep_id
    LOOP
      RAISE NOTICE 'RBAC redesign: clearing duplicate employee_id % link on user % (%) — keeping user %',
        v_emp, v_cleared.id, v_cleared.email, v_keep_id;
      UPDATE users SET employee_id = NULL, updated_at = NOW() WHERE id = v_cleared.id;
    END LOOP;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_employee_id ON users (employee_id) WHERE employee_id IS NOT NULL;

COMMIT;
