-- =============================================================================
-- AI Insights: "done" marker per (Admin tenant, month, job).
--
-- Once every BU / Sub-BU of a tenant is synced for a month and a job has been processed for it, the
-- scheduler records it here and never looks at that tenant + month + job again — no data queries, no AI.
-- A manual run (POST /ai-insights/run/:jobKey) ignores the marker, and deleting a row re-opens it.
-- Safe to re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS ai_insight_period_state (
  id              SERIAL PRIMARY KEY,
  tenant_admin_id INTEGER      NOT NULL,
  period_month    DATE         NOT NULL,
  job_key         VARCHAR(100) NOT NULL,
  completed_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_ai_insight_period_state UNIQUE (job_key, period_month, tenant_admin_id)
);

COMMIT;
