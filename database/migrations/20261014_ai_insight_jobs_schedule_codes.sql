-- =============================================================================
-- AI Insight jobs — show the schedule as a readable code instead of a raw cron expression.
--
--   DL HH:mm       daily            WL DAY HH:mm   weekly   (DAY = MON..SUN)
--   ML D HH:mm     monthly          QL D HH:mm     quarterly (Jan/Apr/Jul/Oct)
--   MI n           every n minutes  HL [mm]        hourly
--
-- Same schedules as before, only written differently. A row is converted only while its
-- cron_expression still holds the original seeded value, so a schedule someone edited by
-- hand is left alone. The scheduler accepts both forms, so this is purely cosmetic.
-- Safe to re-run.
-- =============================================================================

BEGIN;

UPDATE ai_insight_jobs j
   SET cron_expression = v.code, updated_at = NOW()
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
   AND j.cron_expression = v.old_cron;

COMMIT;
