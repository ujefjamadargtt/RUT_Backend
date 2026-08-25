-- =============================================================================
-- Employee-as-Identity Redesign — Phase 4: synthesize Employee rows for
-- Users that never had one.
--
-- Platform Admin / Admin / Entity Admin accounts (and any other User created
-- without an Employee link) have users.employee_id IS NULL today — there is
-- no Employee record to promote to a login identity. Since login is moving
-- to Employee entirely, each such User gets a synthetic Employee row created
-- and linked back, using the best available data (email local-part as a
-- name, current role name as designation). This is a one-time, best-effort
-- synthesis — there is no better source data for these fields for an
-- account that was never an Employee.
--
-- Hard-fails if any user still lacks a linked employee afterward — every
-- later step in this migration sequence assumes full coverage.
--
-- Discovered while first running this migration: the live DB enforces
-- `employees.company_id NOT NULL DEFAULT 1` even though the Sequelize
-- model (src/models/Employee.js) has always declared it `allowNull: true`
-- — one more instance of the out-of-band schema drift this project has hit
-- before (see database/migrations/20260803_ensure_service_categories_schema.sql
-- and 20260842's own note). Platform Admin/Admin/Entity Admin accounts
-- legitimately have no home BU, so the correct fix is to relax the DB
-- constraint to match the model's already-correct intent, not to fabricate
-- a company_id=1 membership these accounts don't actually have.
--
-- Safe to re-run (loop only ever touches rows still matching employee_id
-- IS NULL).
-- =============================================================================

BEGIN;

ALTER TABLE employees ALTER COLUMN company_id DROP NOT NULL;
ALTER TABLE employees ALTER COLUMN company_id DROP DEFAULT;

DO $$
DECLARE
  u RECORD;
  v_new_employee_id INT;
BEGIN
  FOR u IN SELECT * FROM users WHERE employee_id IS NULL LOOP
    INSERT INTO employees (
      company_id, employee_code, full_name, designation, email, password,
      status, is_deleted, created_by, updated_by, created_at, updated_at
    ) VALUES (
      u.company_id,
      'SYS' || LPAD(u.id::text, 6, '0'),
      INITCAP(REPLACE(REPLACE(SPLIT_PART(u.email, '@', 1), '.', ' '), '_', ' ')),
      (SELECT role_name FROM roles WHERE id = u.role_id),
      u.email,
      u.password,
      u.status,
      u.is_deleted,
      u.created_by,
      u.updated_by,
      NOW(),
      NOW()
    )
    RETURNING id INTO v_new_employee_id;

    UPDATE users SET employee_id = v_new_employee_id WHERE id = u.id;
  END LOOP;
END $$;

DO $$
DECLARE v_remaining INT;
BEGIN
  SELECT COUNT(*) INTO v_remaining FROM users WHERE employee_id IS NULL;
  IF v_remaining > 0 THEN
    RAISE EXCEPTION 'synthesize_employees_for_userless_admins: % users still have no linked employee', v_remaining;
  END IF;
END $$;

COMMIT;
