-- =============================================================================
-- Employee-as-Identity Redesign — Phase 1: Employee login columns.
--
-- Employees become the primary login identity going forward. Adds
-- `password` (bcrypt hash, mirrors users.password) and `email` — native to
-- Employee for the first time; previously only reachable by joining to a
-- linked User (see 20260842_employees_drop_login_columns.sql, which removed
-- an earlier Employee-direct-login attempt this redesign intentionally
-- reverses, on purpose, with explicit sign-off).
--
-- Both nullable at the DB level: an Employee with no linked User historically
-- has nothing to backfill, and "required to log in" is an app-layer rule,
-- not a NOT NULL constraint here. Every Employee that DOES have a linked
-- User (at most one, per uq_users_employee_id) gets its email+password
-- copied over below, so login continuity is preserved once `users` is
-- truncated later in this migration sequence.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS password VARCHAR(255),
  ADD COLUMN IF NOT EXISTS email VARCHAR(100);

UPDATE employees e
SET email = u.email,
    password = u.password
FROM users u
WHERE u.employee_id = e.id
  AND (e.email IS NULL OR e.password IS NULL);

CREATE UNIQUE INDEX IF NOT EXISTS uq_employees_email ON employees (email) WHERE email IS NOT NULL;

COMMIT;
