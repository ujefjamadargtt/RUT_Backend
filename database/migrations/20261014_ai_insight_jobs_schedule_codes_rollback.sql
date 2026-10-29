-- Rollback for 20261014_ai_insight_jobs_schedule_codes.sql
-- Restores the original raw cron expressions for rows still holding the seeded code.
BEGIN;

UPDATE ai_insight_jobs j
   SET cron_expression = v.old_cron, updated_at = NOW()
  FROM (VALUES
    ('weekly_resource_digest',  '0 9 * * 1',       'WL MON 09:00'),
    ('po_ending_alerts',        '0 8 * * *',       'DL 08:00'),
    ('bench_escalation',        '15 8 * * *',      'DL 08:15'),
    ('sole_contributor_risk',   '0 9 * * 2',       'WL TUE 09:00'),
    ('monthly_cost_commentary', '0 9 1 * *',       'ML 1 09:00'),
    ('client_concentration',    '30 9 1 * *',      'ML 1 09:30'),
    ('utilization_anomaly',     '0 10 1 * *',      'ML 1 10:00'),
    ('quarter_end_review',      '0 9 1 1,4,7,10 *', 'QL 1 09:00')
  ) AS v(job_key, old_cron, code)
 WHERE j.job_key = v.job_key
   AND j.cron_expression = v.code;

COMMIT;
