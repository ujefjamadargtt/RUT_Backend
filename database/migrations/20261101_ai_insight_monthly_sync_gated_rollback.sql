-- Rollback for 20261101_ai_insight_monthly_sync_gated.sql
-- Removes the monthly (scoped) reports and their columns, and switches the old jobs back on.
BEGIN;

DELETE FROM ai_insights WHERE scope_type IS NOT NULL;
DELETE FROM ai_insight_jobs
 WHERE job_key LIKE 'bu\_%' ESCAPE '\' OR job_key LIKE 'tenant\_%' ESCAPE '\';

DROP INDEX IF EXISTS uq_ai_insights_bu_period_job;
DROP INDEX IF EXISTS uq_ai_insights_tenant_period_job;
DROP INDEX IF EXISTS idx_ai_insights_period_month;
ALTER TABLE ai_insights DROP CONSTRAINT IF EXISTS chk_ai_insights_company_required;
ALTER TABLE ai_insights ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE ai_insights DROP CONSTRAINT IF EXISTS chk_ai_insights_scope_type;
ALTER TABLE ai_insights DROP CONSTRAINT IF EXISTS chk_ai_insights_report_state;
ALTER TABLE ai_insights
  DROP COLUMN IF EXISTS period_month,
  DROP COLUMN IF EXISTS scope_type,
  DROP COLUMN IF EXISTS tenant_admin_id,
  DROP COLUMN IF EXISTS report_state,
  DROP COLUMN IF EXISTS sync_status,
  DROP COLUMN IF EXISTS data_signature;

UPDATE ai_insight_jobs
   SET is_active = true
 WHERE job_key IN (
   'weekly_resource_digest', 'po_ending_alerts', 'bench_escalation', 'sole_contributor_risk',
   'monthly_cost_commentary', 'client_concentration', 'utilization_anomaly', 'quarter_end_review'
 );

COMMIT;
