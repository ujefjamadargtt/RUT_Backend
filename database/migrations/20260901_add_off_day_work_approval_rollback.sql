-- Rollback for 20260901_add_off_day_work_approval.sql.

BEGIN;

DROP TABLE IF EXISTS off_day_work_requests;

ALTER TABLE companies DROP CONSTRAINT IF EXISTS chk_companies_saturday_off_rule;
ALTER TABLE companies DROP COLUMN IF EXISTS saturday_off_rule;

COMMIT;
