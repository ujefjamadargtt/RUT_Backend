-- =============================================================================
-- AI Insights — audience is now Admin + BU Admin for every job.
--
-- The seeded audiences used legacy role names (Management, Division Head, Finance,
-- Project Manager, HR) that the RBAC redesign remapped away (see 20260838), so
-- GET /ai-insights/my-role and /unread matched nobody. Until audiences are designed
-- per role again, every insight is addressed to Admin and BU Admin.
--
-- Updates both the job configuration (ai_insight_jobs, used for newly generated
-- insights) and the insights already generated (ai_insights, so history stays visible).
-- ensureSeeded() never overwrites an existing job row, so the table must be updated here.
-- Safe to re-run: only rows that differ from the target are touched.
-- =============================================================================

BEGIN;

UPDATE ai_insight_jobs
   SET audience_roles = '["Admin", "BU Admin"]'::jsonb,
       updated_at = NOW()
 WHERE audience_roles IS DISTINCT FROM '["Admin", "BU Admin"]'::jsonb;

UPDATE ai_insights
   SET audience_roles = '["Admin", "BU Admin"]'::jsonb,
       updated_at = NOW()
 WHERE audience_roles IS DISTINCT FROM '["Admin", "BU Admin"]'::jsonb;

COMMIT;
