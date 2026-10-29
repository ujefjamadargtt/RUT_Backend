-- Rollback for 20261029_ai_copilot_unmatched_questions.sql
BEGIN;
DROP TABLE IF EXISTS ai_copilot_unmatched_questions;
COMMIT;
