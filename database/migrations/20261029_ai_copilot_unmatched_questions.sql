-- =============================================================================
-- AI Copilot — remember the questions it could not answer.
--
-- A question that matches no supported topic (reason 'unmatched'), or one about a topic the system
-- cannot compute yet such as forecasting (reason 'unsupported'), is saved here so the team can see
-- what people really ask and add the most requested topics. Only the question text, who asked and the
-- Business Units in their reach are kept; no answer data is stored.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS ai_copilot_unmatched_questions (
  id                  BIGSERIAL PRIMARY KEY,
  question            TEXT         NOT NULL,
  question_normalized VARCHAR(500) NOT NULL,
  reason              VARCHAR(20)  NOT NULL CHECK (reason IN ('unmatched', 'unsupported')),
  employee_id         INT          REFERENCES employees (id) ON DELETE SET NULL,
  company_ids         JSONB        NOT NULL DEFAULT '[]',
  created_at          TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_copilot_unmatched_normalized ON ai_copilot_unmatched_questions (question_normalized);
CREATE INDEX IF NOT EXISTS idx_ai_copilot_unmatched_created_at ON ai_copilot_unmatched_questions (created_at DESC);

COMMIT;
