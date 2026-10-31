-- =============================================================================
-- AI Insights: remove the legacy (weekly / daily / monthly / quarterly) jobs and everything they produced.
--
-- The monthly, sync-gated jobs (bu_* / tenant_*) replace them (see 20261101_ai_insight_monthly_sync_gated.sql).
-- This deletes, for the 8 legacy jobs only:
--   * their generated insights (ai_insights.job_key / job_id)
--   * the job rows themselves (ai_insight_jobs)
-- It does NOT touch the monthly reports, new_po_staffing_suggestion, or its insights.
-- The app no longer seeds the legacy jobs, so they do not come back at startup.
-- Safe to re-run.
-- =============================================================================

BEGIN;

DELETE FROM ai_insights
 WHERE job_key IN (
   'weekly_resource_digest', 'po_ending_alerts', 'bench_escalation', 'sole_contributor_risk',
   'monthly_cost_commentary', 'client_concentration', 'utilization_anomaly', 'quarter_end_review'
 )
    OR job_id IN (
   SELECT id FROM ai_insight_jobs
    WHERE job_key IN (
      'weekly_resource_digest', 'po_ending_alerts', 'bench_escalation', 'sole_contributor_risk',
      'monthly_cost_commentary', 'client_concentration', 'utilization_anomaly', 'quarter_end_review'
    )
 );

-- Any other table that points at a legacy job (e.g. a hand-made ai_insights copy) keeps its rows; only the
-- reference is cleared so the job rows can be deleted.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f' AND c.confrelid = 'ai_insight_jobs'::regclass
       AND c.conrelid <> 'ai_insights'::regclass
  LOOP
    EXECUTE format(
      'UPDATE %s SET %I = NULL WHERE %I IN (SELECT id FROM ai_insight_jobs WHERE job_key IN (''weekly_resource_digest'', ''po_ending_alerts'', ''bench_escalation'', ''sole_contributor_risk'', ''monthly_cost_commentary'', ''client_concentration'', ''utilization_anomaly'', ''quarter_end_review''))',
      r.tbl, r.col, r.col);
  END LOOP;
END $$;

DELETE FROM ai_insight_jobs
 WHERE job_key IN (
   'weekly_resource_digest', 'po_ending_alerts', 'bench_escalation', 'sole_contributor_risk',
   'monthly_cost_commentary', 'client_concentration', 'utilization_anomaly', 'quarter_end_review'
 );

COMMIT;
