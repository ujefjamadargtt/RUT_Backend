-- =============================================================================
-- Employee-as-Identity Redesign — Phase 14: truncate `users`.
--
-- `users` is NEVER dropped — only its data is cleared, per explicit
-- instruction. This is the point-of-no-return step: an in-transaction guard
-- clause re-checks every backfill invariant this migration sequence has
-- been building toward (every user linked to an employee, every primary
-- role/company backfilled into employee_roles/employee_business_units) and
-- RAISES an exception rather than proceeding if anything is missing.
--
-- The TRUNCATE itself is deliberately bare (no CASCADE) — by this point in
-- the sequence every table that referenced users.id has either been
-- repointed to employees.id (20260872-20260876), dropped
-- (user_additional_roles, bu_head_company_mappings), had its FK relaxed
-- (20260878), or been truncated alongside it (notifications, user_sessions,
-- also 20260878). If some other, unaccounted-for FK to users.id still
-- exists, Postgres rejects the bare TRUNCATE outright — a second,
-- independent safety net beyond the explicit guard clause below, so a gap
-- in this plan fails loudly instead of silently cascading data loss.
--
-- LOCAL/DEV DATABASE ONLY — not intended for production in this form.
--
-- Safe to re-run (guard clause finds nothing to fail on an already-empty
-- `users` table; TRUNCATE of an empty table is a no-op).
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_null_emp INT;
  v_missing_role INT;
  v_missing_bu INT;
BEGIN
  SELECT COUNT(*) INTO v_null_emp FROM users WHERE employee_id IS NULL;

  SELECT COUNT(*) INTO v_missing_role FROM users u WHERE u.role_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM employee_roles er WHERE er.employee_id = u.employee_id AND er.role_id = u.role_id);

  SELECT COUNT(*) INTO v_missing_bu FROM users u WHERE u.company_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM employee_business_units eb WHERE eb.employee_id = u.employee_id AND eb.business_unit_id = u.company_id);

  IF v_null_emp > 0 OR v_missing_role > 0 OR v_missing_bu > 0 THEN
    RAISE EXCEPTION 'truncate_users blocked: % unlinked users, % unbackfilled roles, % unbackfilled BUs',
      v_null_emp, v_missing_role, v_missing_bu;
  END IF;
END $$;

TRUNCATE TABLE users RESTART IDENTITY;

COMMIT;
