-- Rollback for 20260858_create_cost_budget_master.sql

BEGIN;

DROP TRIGGER IF EXISTS trg_cost_budget_master_updated_at ON cost_budget_master;
DROP TABLE IF EXISTS cost_budget_master;

COMMIT;
