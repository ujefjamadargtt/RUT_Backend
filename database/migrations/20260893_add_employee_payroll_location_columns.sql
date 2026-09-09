-- =============================================================================
-- Employee Master — Payroll Entity / Location / Sub Location columns.
--
-- Adds three purely additive, nullable business-data columns to employees:
--   payroll_entity VARCHAR(64)  — the legal/payroll entity the employee is on
--   location       VARCHAR(256) — employee's work location
--   sub_location   VARCHAR(256) — finer-grained location (site/floor/etc.)
--
-- NULL for every existing employee until backfilled or edited via the
-- Employee Master UI. Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS payroll_entity VARCHAR(64),
  ADD COLUMN IF NOT EXISTS location       VARCHAR(256),
  ADD COLUMN IF NOT EXISTS sub_location   VARCHAR(256);

COMMIT;
