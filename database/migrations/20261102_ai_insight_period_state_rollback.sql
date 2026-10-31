-- Rollback for 20261102_ai_insight_period_state.sql
BEGIN;
DROP TABLE IF EXISTS ai_insight_period_state;
COMMIT;
