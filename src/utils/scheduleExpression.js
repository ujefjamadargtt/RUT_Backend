'use strict';

/**
 * Job schedule — built from plain columns instead of a hand-written cron.
 *
 * ai_insight_jobs carries the schedule in these columns (time is 24-hour, in
 * the app timezone — APP_TIMEZONE, default Asia/Kolkata):
 *
 *   schedule_type | Meaning                       | Columns used                     | Runs
 *   --------------|-------------------------------|----------------------------------|----------------------------------
 *   MI            | Minute-wise (every N minutes) | interval_minutes                 | every 15 minutes
 *   DL            | Daily                         | scheduled_time                   | every day at 08:15
 *   WL            | Weekly                        | week_day, scheduled_time         | every MON at 09:00
 *   ML            | Monthly                       | month_day, scheduled_time        | the 1st of every month at 09:30
 *   QL            | Quarterly                     | month_day, scheduled_time        | day 1 of Jan/Apr/Jul/Oct at 09:00
 *
 * week_day is MON, TUE, WED, THU, FRI, SAT or SUN. month_day is 1-28, so the
 * job fires in every month. interval_minutes must divide 60 evenly (1, 2, 3, 4,
 * 5, 6, 10, 12, 15, 20, 30) so the interval is exact.
 *
 * A job with no schedule_type falls back to its raw cron_expression (if any),
 * so a hand-written cron keeps working. The same rules are enforced in the
 * database by chk_ai_insight_jobs_schedule.
 */

const SCHEDULE_TYPES = ['MI', 'DL', 'WL', 'ML', 'QL'];
const WEEK_DAYS = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
const MINUTE_INTERVALS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30];
const TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/; // HH:mm or HH:mm:ss (a TIME column)

function fail(message) {
  const err = new Error(message);
  err.code = 'INVALID_SCHEDULE';
  throw err;
}

function parseTime(value, type) {
  const match = TIME_PATTERN.exec(String(value == null ? '' : value).trim());
  if (!match) fail(`${type} schedule needs scheduled_time as 24-hour HH:mm (got "${value == null ? '' : value}").`);
  return { hour: parseInt(match[1], 10), minute: parseInt(match[2], 10) };
}

function parseMonthDay(value, type) {
  const day = /^\d{1,2}$/.test(String(value == null ? '' : value).trim()) ? parseInt(value, 10) : NaN;
  if (!(day >= 1 && day <= 28)) fail(`${type} schedule needs month_day between 1 and 28 (got "${value == null ? '' : value}").`);
  return day;
}

/**
 * Convert a job's schedule columns to a standard 5-field cron expression.
 *
 * @param {{ schedule_type?: string|null, scheduled_time?: string|null, week_day?: string|null,
 *           month_day?: number|string|null, interval_minutes?: number|string|null }} job
 * @returns {string|null} cron expression, or null when the job has no schedule_type
 * @throws {Error} code 'INVALID_SCHEDULE' when the columns for the chosen type are missing/invalid
 */
function scheduleToCron(job) {
  const rawType = job && job.schedule_type;
  if (rawType == null || String(rawType).trim() === '') return null;

  const type = String(rawType).trim().toUpperCase();
  if (!SCHEDULE_TYPES.includes(type)) {
    fail(`Unknown schedule_type "${rawType}" — use ${SCHEDULE_TYPES.join(', ')}.`);
  }

  switch (type) {
    case 'MI': {
      const n = /^\d{1,2}$/.test(String(job.interval_minutes == null ? '' : job.interval_minutes).trim())
        ? parseInt(job.interval_minutes, 10)
        : NaN;
      if (!MINUTE_INTERVALS.includes(n)) {
        fail(`MI schedule needs interval_minutes to be one of ${MINUTE_INTERVALS.join(', ')} (got "${job.interval_minutes == null ? '' : job.interval_minutes}").`);
      }
      return n === 1 ? '* * * * *' : `*/${n} * * * *`;
    }
    case 'DL': {
      const { hour, minute } = parseTime(job.scheduled_time, type);
      return `${minute} ${hour} * * *`;
    }
    case 'WL': {
      const weekDay = WEEK_DAYS[String(job.week_day == null ? '' : job.week_day).trim().slice(0, 3).toUpperCase()];
      if (weekDay === undefined) fail(`WL schedule needs week_day as MON, TUE, WED, THU, FRI, SAT or SUN (got "${job.week_day == null ? '' : job.week_day}").`);
      const { hour, minute } = parseTime(job.scheduled_time, type);
      return `${minute} ${hour} * * ${weekDay}`;
    }
    case 'ML': {
      const day = parseMonthDay(job.month_day, type);
      const { hour, minute } = parseTime(job.scheduled_time, type);
      return `${minute} ${hour} ${day} * *`;
    }
    default: { // QL
      const day = parseMonthDay(job.month_day, type);
      const { hour, minute } = parseTime(job.scheduled_time, type);
      return `${minute} ${hour} ${day} 1,4,7,10 *`;
    }
  }
}

/**
 * The cron expression to hand to node-cron for a job: built from its schedule
 * columns when schedule_type is set, otherwise its raw cron_expression, or null
 * when it has neither (an event-driven job).
 *
 * @param {object} job
 * @returns {string|null}
 * @throws {Error} code 'INVALID_SCHEDULE' for an incomplete/invalid schedule_type
 */
function resolveJobCronExpression(job) {
  const fromColumns = scheduleToCron(job);
  if (fromColumns) return fromColumns;

  const raw = job && job.cron_expression ? String(job.cron_expression).trim() : '';
  return raw || null;
}

module.exports = {
  SCHEDULE_TYPES,
  scheduleToCron,
  resolveJobCronExpression,
};
