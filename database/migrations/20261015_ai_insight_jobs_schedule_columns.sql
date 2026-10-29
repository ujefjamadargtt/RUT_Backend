-- =============================================================================
-- AI Insight jobs — the schedule lives in its own columns instead of one text value.
--
--   schedule_type     DL daily | WL weekly | ML monthly | QL quarterly | MI every N minutes
--   scheduled_time    time of day (24h), used by DL / WL / ML / QL
--   week_day          MON..SUN, used by WL
--   month_day         1..28, used by ML / QL (QL = that day of Jan/Apr/Jul/Oct)
--   interval_minutes  1,2,3,4,5,6,10,12,15,20,30, used by MI
--
-- schedule_type NULL means "not scheduled by these columns": an event-driven job, or a row
-- that still uses a hand-written cron_expression, which the scheduler keeps honouring.
-- The CHECK rejects an incomplete schedule (e.g. WL without week_day) at UPDATE time.
--
-- Existing rows are converted from the codes written by 20261014_ai_insight_jobs_schedule_codes
-- ('DL 08:15', 'WL MON 09:00', 'ML 1 09:30', 'QL 1 09:00', 'MI 15'); their cron_expression is
-- then cleared. Anything else is left exactly as it is. Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE ai_insight_jobs
  ADD COLUMN IF NOT EXISTS schedule_type    VARCHAR(2),
  ADD COLUMN IF NOT EXISTS scheduled_time   TIME,
  ADD COLUMN IF NOT EXISTS week_day         VARCHAR(3),
  ADD COLUMN IF NOT EXISTS month_day        SMALLINT,
  ADD COLUMN IF NOT EXISTS interval_minutes SMALLINT;

UPDATE ai_insight_jobs
   SET schedule_type = 'DL',
       scheduled_time = split_part(cron_expression, ' ', 2)::time,
       cron_expression = NULL
 WHERE schedule_type IS NULL
   AND cron_expression ~* '^DL ([01]?[0-9]|2[0-3]):[0-5][0-9]$';

UPDATE ai_insight_jobs
   SET schedule_type = 'WL',
       week_day = UPPER(split_part(cron_expression, ' ', 2)),
       scheduled_time = split_part(cron_expression, ' ', 3)::time,
       cron_expression = NULL
 WHERE schedule_type IS NULL
   AND cron_expression ~* '^WL (MON|TUE|WED|THU|FRI|SAT|SUN) ([01]?[0-9]|2[0-3]):[0-5][0-9]$';

UPDATE ai_insight_jobs
   SET schedule_type = UPPER(split_part(cron_expression, ' ', 1)),
       month_day = split_part(cron_expression, ' ', 2)::smallint,
       scheduled_time = split_part(cron_expression, ' ', 3)::time,
       cron_expression = NULL
 WHERE schedule_type IS NULL
   AND cron_expression ~* '^(ML|QL) ([1-9]|1[0-9]|2[0-8]) ([01]?[0-9]|2[0-3]):[0-5][0-9]$';

UPDATE ai_insight_jobs
   SET schedule_type = 'MI',
       interval_minutes = split_part(cron_expression, ' ', 2)::smallint,
       cron_expression = NULL
 WHERE schedule_type IS NULL
   AND cron_expression ~* '^MI (1|2|3|4|5|6|10|12|15|20|30)$';

ALTER TABLE ai_insight_jobs DROP CONSTRAINT IF EXISTS chk_ai_insight_jobs_schedule;
ALTER TABLE ai_insight_jobs ADD CONSTRAINT chk_ai_insight_jobs_schedule CHECK (
  COALESCE(
    schedule_type IS NULL
    OR (schedule_type = 'MI' AND interval_minutes IN (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30))
    OR (schedule_type = 'DL' AND scheduled_time IS NOT NULL)
    OR (schedule_type = 'WL' AND scheduled_time IS NOT NULL
        AND week_day IN ('MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'))
    OR (schedule_type IN ('ML', 'QL') AND scheduled_time IS NOT NULL AND month_day BETWEEN 1 AND 28),
    false
  )
);

COMMIT;
