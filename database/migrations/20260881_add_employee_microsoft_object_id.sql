-- =============================================================================
-- Microsoft Entra ID SSO — Employee identifier column.
--
-- Adds employees.microsoft_object_id to store Microsoft's stable, per-tenant,
-- non-reassignable user identifier (the `oid` claim), captured on first
-- successful Microsoft SSO login (see authRepository.updateMicrosoftObjectId()).
--
-- Email remains the sole login-matching key (authRepository.findEmployeeByEmail)
-- — this column is purely additive, for audit/future hardening only, and does
-- not change how any existing employee logs in. NULL for every employee who
-- has never signed in via Microsoft SSO, which is fine: Postgres allows
-- unlimited NULLs under a plain/partial UNIQUE index (same pattern already
-- used by uq_employees_email, see 20260864_add_employee_login_columns.sql).
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS microsoft_object_id VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS uq_employees_microsoft_object_id
  ON employees (microsoft_object_id) WHERE microsoft_object_id IS NOT NULL;

COMMIT;
