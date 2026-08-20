-- Rollback for 20260859_create_resource_budget_master.sql

BEGIN;

DROP TRIGGER IF EXISTS trg_resource_budget_master_updated_at ON resource_budget_master;
DROP TABLE IF EXISTS resource_budget_master;

COMMIT;
