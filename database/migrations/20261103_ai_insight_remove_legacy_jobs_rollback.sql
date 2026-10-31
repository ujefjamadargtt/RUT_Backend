-- Rollback for 20261103_ai_insight_remove_legacy_jobs.sql
-- Deleted insights cannot be restored. This only re-creates the 8 legacy job rows, switched OFF
-- (the app no longer runs them); restore the insights from a backup if they are needed.
BEGIN;

INSERT INTO ai_insight_jobs (job_key, title, description, frequency, audience_roles, is_active)
SELECT v.job_key, v.title, v.description, v.frequency, '["Admin", "BU Admin"]'::jsonb, false
  FROM (VALUES
    ('weekly_resource_digest', 'Weekly Resource Digest', 'Overall utilization, major risks, achievements, and top 3 actions for the week just ended.', 'weekly'),
    ('po_ending_alerts', 'PO Ending Alerts', 'Service POs ending within 30/15/7 days, employees becoming free, and suggested reallocations.', 'daily'),
    ('bench_escalation', 'Bench Escalation', 'Employees with bench >= 75% over the trailing 30 days.', 'daily'),
    ('sole_contributor_risk', 'Sole Contributor Risk', 'Active projects where one employee contributes more than 90% of hours.', 'weekly'),
    ('monthly_cost_commentary', 'Monthly Cost Commentary', 'Cost movement vs the prior month, reasons, and recommendations.', 'monthly'),
    ('client_concentration', 'Client Concentration', 'Top clients, revenue share, trend, and concentration risk.', 'monthly'),
    ('utilization_anomaly', 'Utilization Anomaly', 'Current vs previous month utilization.', 'monthly'),
    ('quarter_end_review', 'Quarter End Review', 'Complete quarter review.', 'quarterly')
  ) AS v(job_key, title, description, frequency)
 WHERE NOT EXISTS (SELECT 1 FROM ai_insight_jobs j WHERE j.job_key = v.job_key);

COMMIT;
