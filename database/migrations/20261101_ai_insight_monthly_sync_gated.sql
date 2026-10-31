-- =============================================================================
-- AI Insights: monthly, sync-gated reports (one record per scope + month + job).
--
-- * period_month    first day of the month the report is about
-- * scope_type      'bu'     -> one leaf Business Unit / Sub-BU (company_id set)
--                   'tenant' -> one Admin tenant, all its BUs together (tenant_admin_id set, company_id NULL)
--                   NULL     -> legacy / event-driven insight (unchanged)
-- * report_state    'complete' | 'partial' (some BUs not synced yet) | 'pending_sync' (message only)
-- * sync_status     { synced_count, total_count, synced: [{id,name}], pending: [{id,name}] }
-- * data_signature  hash of the data the report was built from; an unchanged signature means no new AI call
--
-- A later run for the same (scope, month, job) UPDATES the existing row instead of adding another one.
-- The previous weekly / daily / monthly jobs are switched off (rows kept: old insights still point at them).
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE ai_insights
  ADD COLUMN IF NOT EXISTS period_month    DATE,
  ADD COLUMN IF NOT EXISTS scope_type      VARCHAR(10),
  ADD COLUMN IF NOT EXISTS tenant_admin_id INTEGER,
  ADD COLUMN IF NOT EXISTS report_state    VARCHAR(20) NOT NULL DEFAULT 'complete',
  ADD COLUMN IF NOT EXISTS sync_status     JSONB,
  ADD COLUMN IF NOT EXISTS data_signature  VARCHAR(64);

-- A tenant-level report belongs to an Admin tenant, not to one Company.
ALTER TABLE ai_insights ALTER COLUMN company_id DROP NOT NULL;
ALTER TABLE ai_insights DROP CONSTRAINT IF EXISTS chk_ai_insights_company_required;
ALTER TABLE ai_insights ADD CONSTRAINT chk_ai_insights_company_required
  CHECK (scope_type = 'tenant' OR company_id IS NOT NULL);

ALTER TABLE ai_insights DROP CONSTRAINT IF EXISTS chk_ai_insights_scope_type;
ALTER TABLE ai_insights ADD CONSTRAINT chk_ai_insights_scope_type
  CHECK (scope_type IS NULL OR scope_type IN ('bu', 'tenant'));

ALTER TABLE ai_insights DROP CONSTRAINT IF EXISTS chk_ai_insights_report_state;
ALTER TABLE ai_insights ADD CONSTRAINT chk_ai_insights_report_state
  CHECK (report_state IN ('complete', 'partial', 'pending_sync'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_insights_bu_period_job
  ON ai_insights (company_id, period_month, job_key) WHERE scope_type = 'bu';
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_insights_tenant_period_job
  ON ai_insights (tenant_admin_id, period_month, job_key) WHERE scope_type = 'tenant';
CREATE INDEX IF NOT EXISTS idx_ai_insights_period_month ON ai_insights (period_month);

-- Old schedule-based jobs: off (history stays). New monthly jobs are seeded by the app at startup.
UPDATE ai_insight_jobs
   SET is_active = false
 WHERE job_key IN (
   'weekly_resource_digest', 'po_ending_alerts', 'bench_escalation', 'sole_contributor_risk',
   'monthly_cost_commentary', 'client_concentration', 'utilization_anomaly', 'quarter_end_review'
 );

COMMIT;
