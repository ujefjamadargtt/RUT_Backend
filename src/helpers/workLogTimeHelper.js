'use strict';

/**
 * Employee Work Log start_time/end_time helpers — shared by
 * employeeTimesheetService.js (server-side hours calculation/validation)
 * and the Work Log Time Report (display formatting). Kept isolated here
 * rather than added to the general-purpose dateHelper.js, since this is
 * time-of-day-only (no date component) logic specific to Work Logs.
 */

// 24-hour "HH:MM" or "HH:MM:SS".
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;

/**
 * @param {string} timeStr - "HH:MM" or "HH:MM:SS"
 * @returns {number} minutes since midnight
 */
function toMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map((part) => parseInt(part, 10));
  return h * 60 + m;
}

/**
 * Server-side hours calculation from a start/end time pair — the single
 * source of truth whenever both are supplied; a caller-provided `hours`
 * value is never trusted alongside them (see employeeTimesheetService.js's
 * resolveHoursAndTimes()). Only a same-day interval is supported: end_time
 * must be strictly after start_time — an overnight span (e.g. 23:00 ->
 * 01:00) is rejected rather than silently treated as spanning midnight,
 * per this feature's initial-implementation business rule.
 *
 * @param {string} startTime - "HH:MM" or "HH:MM:SS"
 * @param {string} endTime - "HH:MM" or "HH:MM:SS"
 * @returns {number} hours, rounded to 2 decimal places
 * @throws {Error} statusCode 400 if endTime is not strictly after startTime
 */
function calculateHoursFromTimes(startTime, endTime) {
  const startMinutes = toMinutes(startTime);
  const endMinutes = toMinutes(endTime);

  if (endMinutes <= startMinutes) {
    const err = new Error('End time must be greater than start time.');
    err.statusCode = 400;
    throw err;
  }

  return Math.round(((endMinutes - startMinutes) / 60) * 100) / 100;
}

/**
 * Format a stored "HH:MM:SS" time for display, e.g. "10:00 AM" — reports
 * only; the database always stores plain 24-hour TIME, never a formatted
 * string.
 *
 * @param {string|null} timeStr - "HH:MM:SS" (or null)
 * @returns {string|null}
 */
function formatTimeForDisplay(timeStr) {
  if (!timeStr) return null;
  const [hStr, mStr] = timeStr.split(':');
  let h = parseInt(hStr, 10);
  const period = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${String(h).padStart(2, '0')}:${mStr} ${period}`;
}

/**
 * Reject a set of {start_time, end_time} segments (one Module/Task line's
 * `time_entries`, see employeeTimesheetService.resolveHoursAndTimeEntries)
 * if any two overlap. Segments are only ever compared against each other
 * within the SAME line (same Service PO + hierarchy node + date) — that is
 * the only scope in which "overlap" is meaningful, since two different
 * Module/Tasks legitimately don't share a clock.
 *
 * @param {Array<{ start_time: string, end_time: string }>} entries
 * @throws {Error} statusCode 400 on the first overlap found
 */
function assertNoOverlappingEntries(entries) {
  const sorted = [...entries].sort((a, b) => toMinutes(a.start_time) - toMinutes(b.start_time));
  for (let i = 1; i < sorted.length; i++) {
    if (toMinutes(sorted[i].start_time) < toMinutes(sorted[i - 1].end_time)) {
      const err = new Error(
        `Time entries overlap: ${sorted[i - 1].start_time}-${sorted[i - 1].end_time} and ` +
        `${sorted[i].start_time}-${sorted[i].end_time}.`
      );
      err.statusCode = 400;
      throw err;
    }
  }
}

/**
 * Sum a set of already-computed per-entry hours into the combined total for
 * one Module/Task on one date — e.g. 09:30-10:20 (0.83h) + 14:00-15:00 (1h)
 * = 1.83h, the value written into employee_work_logs.hours.
 *
 * @param {number[]} hoursList
 * @returns {number} rounded to 2 decimal places
 */
function sumHours(hoursList) {
  return Math.round(hoursList.reduce((sum, h) => sum + h, 0) * 100) / 100;
}

/**
 * Format a decimal hours value as "1 hr 50 mins" for display — the combined-
 * total presentation the Work Log Time Report/UI shows alongside each
 * Module/Task's individual time entries (see this file's header comment and
 * the ticket example: "Total = 110 minutes = 1 hour 50 minutes").
 *
 * @param {number} hours
 * @returns {string}
 */
function formatHoursAsHrMin(hours) {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m} min${m === 1 ? '' : 's'}`;
  if (m === 0) return `${h} hr${h === 1 ? '' : 's'}`;
  return `${h} hr${h === 1 ? '' : 's'} ${m} min${m === 1 ? '' : 's'}`;
}

module.exports = {
  TIME_PATTERN,
  calculateHoursFromTimes,
  formatTimeForDisplay,
  assertNoOverlappingEntries,
  sumHours,
  formatHoursAsHrMin,
};
