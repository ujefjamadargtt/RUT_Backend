-- =============================================================================
-- RBAC Redesign — Phase 9: Employee becomes pure business data.
--
-- Employees no longer authenticate directly — login happens only through
-- User Master (see Stage 2). Drops the Employee-direct-login columns
-- (`password`, `email_id`) and their supporting indexes/constraints, and
-- drops `employee_sessions` (the refresh-token store for the old
-- Employee-direct-login JWT audience, now unused since employeeAuth.js /
-- the employee JWT audience are removed in Stage 2).
--
-- `idx_employees_email_active` and `employees_email_id_key` were added
-- out-of-band against the live DB (never created by a tracked migration —
-- see analysis notes), so both are dropped defensively with IF EXISTS
-- rather than assumed absent.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

DROP INDEX IF EXISTS idx_employees_email_active;
DROP INDEX IF EXISTS idx_employees_email_id;
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_email_id_key;
ALTER TABLE employees DROP COLUMN IF EXISTS email_id;
ALTER TABLE employees DROP COLUMN IF EXISTS password;

DROP TABLE IF EXISTS employee_sessions;

COMMIT;
