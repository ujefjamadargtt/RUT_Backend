-- Rollback for 20261015_ai_insight_jobs_schedule_columns.sql
-- Rebuilds a raw cron expression from the schedule columns, then drops the columns.
BEGIN;

UPDATE ai_insight_jobs
   SET cron_expression = CASE schedule_type
     WHEN 'MI' THEN CASE WHEN interval_minutes = 1 THEN '* * * * *'
                         ELSE format('*/%s * * * *', interval_minutes) END
     WHEN 'DL' THEN format('%s %s * * *',
                           EXTRACT(MINUTE FROM scheduled_time)::int, EXTRACT(HOUR FROM scheduled_time)::int)
     WHEN 'WL' THEN format('%s %s * * %s',
                           EXTRACT(MINUTE FROM scheduled_time)::int, EXTRACT(HOUR FROM scheduled_time)::int,
                           CASE week_day WHEN 'SUN' THEN 0 WHEN 'MON' THEN 1 WHEN 'TUE' THEN 2 WHEN 'WED' THEN 3
                                         WHEN 'THU' THEN 4 WHEN 'FRI' THEN 5 WHEN 'SAT' THEN 6 END)
     WHEN 'ML' THEN format('%s %s %s * *',
                           EXTRACT(MINUTE FROM scheduled_time)::int, EXTRACT(HOUR FROM scheduled_time)::int, month_day)
     WHEN 'QL' THEN format('%s %s %s 1,4,7,10 *',
                           EXTRACT(MINUTE FROM scheduled_time)::int, EXTRACT(HOUR FROM scheduled_time)::int, month_day)
   END
 WHERE schedule_type IS NOT NULL;

ALTER TABLE ai_insight_jobs DROP CONSTRAINT IF EXISTS chk_ai_insight_jobs_schedule;
ALTER TABLE ai_insight_jobs
  DROP COLUMN IF EXISTS schedule_type,
  DROP COLUMN IF EXISTS scheduled_time,
  DROP COLUMN IF EXISTS week_day,
  DROP COLUMN IF EXISTS month_day,
  DROP COLUMN IF EXISTS interval_minutes;

COMMIT;
