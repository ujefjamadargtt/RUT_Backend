-- Rollback for 20261014_ai_insight_audience_admin_bu_admin.sql
-- Restores each job's original seeded audience (matched by job_key) on both tables.
BEGIN;

UPDATE ai_insight_jobs j
   SET audience_roles = v.roles::jsonb, updated_at = NOW()
  FROM (VALUES
    ('weekly_resource_digest',     '["Management"]'),
    ('po_ending_alerts',           '["Project Manager", "Division Head"]'),
    ('bench_escalation',           '["HR"]'),
    ('sole_contributor_risk',      '["Division Head"]'),
    ('monthly_cost_commentary',    '["Finance", "Management"]'),
    ('client_concentration',       '["Management"]'),
    ('utilization_anomaly',        '["Management"]'),
    ('quarter_end_review',         '["Management"]'),
    ('new_po_staffing_suggestion', '["Project Manager"]')
  ) AS v(job_key, roles)
 WHERE j.job_key = v.job_key;

UPDATE ai_insights i
   SET audience_roles = v.roles::jsonb, updated_at = NOW()
  FROM (VALUES
    ('weekly_resource_digest',     '["Management"]'),
    ('po_ending_alerts',           '["Project Manager", "Division Head"]'),
    ('bench_escalation',           '["HR"]'),
    ('sole_contributor_risk',      '["Division Head"]'),
    ('monthly_cost_commentary',    '["Finance", "Management"]'),
    ('client_concentration',       '["Management"]'),
    ('utilization_anomaly',        '["Management"]'),
    ('quarter_end_review',         '["Management"]'),
    ('new_po_staffing_suggestion', '["Project Manager"]')
  ) AS v(job_key, roles)
 WHERE i.job_key = v.job_key;

COMMIT;
