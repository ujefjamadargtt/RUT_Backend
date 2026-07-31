-- =============================================================================
-- Employee Self Timesheet — Phase 1: give Employees a password column so they
-- can authenticate through the same /auth/login endpoint as Users. Nullable
-- (an Employee with no password set simply cannot log in yet, until an Admin
-- provisions one via POST/PUT /employees or PUT /employees/:id/reset-password).
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE employees ADD COLUMN IF NOT EXISTS password VARCHAR(255);

-- email_id lookups happen on every login attempt for an unrecognised-user
-- email; index it for that lookup (uniqueness itself stays an application-
-- level rule — see employeeRepository.findAllEmailsGlobal — not enforced here).
CREATE INDEX IF NOT EXISTS idx_employees_email_id ON employees (email_id);

COMMIT;
