-- =============================================================================
-- Employee Master — Original Entity column.
--
-- Adds a purely additive, nullable business-data column to employees:
--   original_entity VARCHAR(512) — the employee's originating legal entity
--
-- NULL for every existing employee until backfilled or edited via the
-- Employee Master UI. Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS original_entity VARCHAR(512);

COMMIT;
