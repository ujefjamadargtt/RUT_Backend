-- Migration: remove upper-bound check on timesheets.hours_logged
-- Drops existing constraint (if present) and enforces only hours_logged >= 0

BEGIN;

ALTER TABLE IF EXISTS timesheets
  DROP CONSTRAINT IF EXISTS timesheets_hours_logged_check;

-- Ensure column is numeric with two decimal places (no change if already appropriate)
ALTER TABLE IF EXISTS timesheets
  ALTER COLUMN hours_logged TYPE DECIMAL(5,2) USING hours_logged::numeric;

ALTER TABLE IF EXISTS timesheets
  ADD CONSTRAINT timesheets_hours_logged_check CHECK (hours_logged >= 0);

COMMIT;

-- To apply:
-- psql -U <db_user> -d <database> -f database/migrations/20260626_remove_hours_upper_bound.sql
