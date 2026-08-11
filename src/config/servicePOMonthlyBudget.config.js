'use strict';

const moment = require('moment-timezone');
const { DEFAULT_TZ, DATE_FORMAT } = require('../helpers/dateHelper');

/**
 * Service PO Monthly Budget — deadline business rule, centralized here so it
 * can be changed (day-of-month, or a future more elaborate rule) without
 * touching the service/controller layer. Currently: monthly financial data
 * (Invoice Amount / Billed Amount) must be filled in by this day of every
 * month. Override via SERVICE_PO_BUDGET_DEADLINE_DAY for environments that
 * need a different cutoff.
 */
const DEADLINE_DAY = parseInt(process.env.SERVICE_PO_BUDGET_DEADLINE_DAY, 10) || 10;

/**
 * Compute the deadline date and status for a given month/year, relative to
 * "today" in the app's configured timezone.
 *
 * @param {number} month - 1-based month
 * @param {number} year
 * @returns {{ deadline: string, days_remaining: number, deadline_passed: boolean }}
 */
function getDeadlineInfo(month, year) {
  const daysInMonth = moment.tz({ year, month: month - 1 }, DEFAULT_TZ).daysInMonth();
  const deadlineDay = Math.min(DEADLINE_DAY, daysInMonth);
  const deadline = moment.tz({ year, month: month - 1, day: deadlineDay }, DEFAULT_TZ).startOf('day');
  const today = moment.tz(DEFAULT_TZ).startOf('day');

  const daysDiff = deadline.diff(today, 'days');

  return {
    deadline: deadline.format(DATE_FORMAT),
    days_remaining: Math.max(daysDiff, 0),
    deadline_passed: daysDiff < 0,
  };
}

module.exports = {
  DEADLINE_DAY,
  getDeadlineInfo,
};
