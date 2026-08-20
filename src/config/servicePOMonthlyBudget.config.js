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

/**
 * Edit-window rule: a Service PO Monthly Budget (Invoice Amount / Billed
 * Amount) record for a given month is writable starting the 1st day of
 * THAT month, through the 7th day of the FOLLOWING month (inclusive) —
 * e.g. August data is writable 01-Aug through 07-Sep; it locks starting
 * 08-Sep. A month that hasn't started yet is also rejected (its window
 * hasn't opened). Works across a year boundary (December's window runs
 * into January) since the lock date is computed as "start of month + 1
 * month, day 7", never hardcoded. Both create and update go through the
 * single upsert() service function, so this one check covers both.
 *
 * Supersedes the previous rule (previous-calendar-month only, until the
 * 7th of the current month) — there is only ever one Invoice Master date
 * rule active at a time.
 *
 * @param {number} month - 1-based month being written
 * @param {number} year
 * @throws {Error} statusCode 400 when outside the allowed window
 */
function assertWithinEditWindow(month, year) {
  const today = moment.tz(DEFAULT_TZ).startOf('day');
  const start = moment.tz({ year, month: month - 1, day: 1 }, DEFAULT_TZ).startOf('day');
  const lockDate = start.clone().add(1, 'month').date(7).startOf('day');

  const isAllowed = today.isSameOrAfter(start) && today.isSameOrBefore(lockDate);

  if (!isAllowed) {
    const err = new Error(
      `Invoice Master data for ${start.format('MMMM YYYY')} can only be added or modified from ` +
      `${start.format('DD-MMM-YYYY')} to ${lockDate.format('DD-MMM-YYYY')}.`
    );
    err.statusCode = 400;
    throw err;
  }
}

module.exports = {
  DEADLINE_DAY,
  getDeadlineInfo,
  assertWithinEditWindow,
};
