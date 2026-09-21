'use strict';

const moment = require('moment-timezone');

/**
 * Off-Day Approval Gate — the pure day-check: is a given date an off day
 * under a BU's Week Off Policy (companies.saturday_off_rule)?
 *
 * Sunday is off for every BU, always — none of the known patterns vary it,
 * so it is a platform rule here rather than a per-BU column (see
 * database/migrations/20260901_add_off_day_work_approval.sql). Only
 * Saturday varies, by which occurrence in the month it is (1st..5th).
 */

const SATURDAY_OFF_RULES = ['ALL', 'ALT_1_3', 'ALT_2_4', 'NONE'];

/**
 * Which occurrence of its weekday this date is within its month — e.g. the
 * 19th is the 3rd occurrence of whatever weekday the 19th falls on.
 *
 * @param {moment.Moment} m
 * @returns {number} 1-5
 */
function occurrenceInMonth(m) {
  return Math.ceil(m.date() / 7);
}

/**
 * @param {string} dateStr - YYYY-MM-DD
 * @param {string} saturdayOffRule - one of SATURDAY_OFF_RULES; an
 *   unrecognized value falls back to 'ALL' (the safest/strictest default,
 *   matching companies.saturday_off_rule's own column default) rather than
 *   throwing — this runs on every Daily Timesheet write and must never
 *   itself be the reason one fails.
 * @returns {boolean}
 */
function isOffDay(dateStr, saturdayOffRule) {
  const m = moment(dateStr, 'YYYY-MM-DD', true);
  if (!m.isValid()) {
    const err = new Error(`"${dateStr}" is not a valid date.`);
    err.statusCode = 400;
    throw err;
  }

  const dayOfWeek = m.day(); // 0 = Sunday, 6 = Saturday
  if (dayOfWeek === 0) return true;
  if (dayOfWeek !== 6) return false;

  const rule = SATURDAY_OFF_RULES.includes(saturdayOffRule) ? saturdayOffRule : 'ALL';
  if (rule === 'ALL') return true;
  if (rule === 'NONE') return false;

  const occurrence = occurrenceInMonth(m);
  if (rule === 'ALT_1_3') return occurrence === 1 || occurrence === 3;
  return occurrence === 2 || occurrence === 4; // ALT_2_4
}

module.exports = {
  SATURDAY_OFF_RULES,
  isOffDay,
};
