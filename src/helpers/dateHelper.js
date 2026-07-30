'use strict';

const moment = require('moment-timezone');

// Default timezone for the whole project (can be overridden via env)
const DEFAULT_TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';
moment.tz.setDefault(DEFAULT_TZ);

const DATE_FORMAT = 'YYYY-MM-DD';
const DISPLAY_FORMAT = 'DD MMM YYYY';
const DATETIME_FORMAT = 'YYYY-MM-DD HH:mm:ss';
const ISO_TZ_FORMAT = 'YYYY-MM-DDTHH:mm:ssZ';

/**
 * Get the current month as a 1-based integer (1–12).
 *
 * @returns {number}
 */
function getCurrentMonth() {
  return moment().month() + 1; // moment months are 0-indexed
}

/**
 * Get the current 4-digit year.
 *
 * @returns {number}
 */
function getCurrentYear() {
  return moment().year();
}

/**
 * Format a date value to a standard ISO date string (YYYY-MM-DD).
 *
 * Accepts a Date object, ISO string, moment object, or null/undefined.
 *
 * @param {Date|string|moment.Moment|null|undefined} date
 * @param {string} [outputFormat=DATE_FORMAT] - Desired output format.
 * @returns {string|null}  Formatted string, or null if input is falsy or invalid.
 */
function formatDate(date, outputFormat = DATE_FORMAT) {
  if (!date) return null;
  const m = moment(date);
  if (!m.isValid()) return null;
  return m.format(outputFormat);
}

/**
 * Format a date for display (e.g. "15 Jun 2024").
 *
 * @param {Date|string|null} date
 * @returns {string|null}
 */
function formatDisplayDate(date) {
  return formatDate(date, DISPLAY_FORMAT);
}

/**
 * Format a datetime value.
 *
 * @param {Date|string|null} date
 * @returns {string|null}
 */
function formatDateTime(date) {
  return formatDate(date, DATETIME_FORMAT);
}

/**
 * Validate that a start date is strictly before (or equal to) an end date.
 *
 * @param {Date|string} startDate
 * @param {Date|string} endDate
 * @param {boolean}     [allowEqual=true]  - Whether start === end is acceptable.
 * @returns {boolean}
 */
function isValidDateRange(startDate, endDate, allowEqual = true) {
  if (!startDate || !endDate) return false;

  const start = moment(startDate);
  const end = moment(endDate);

  if (!start.isValid() || !end.isValid()) return false;

  return allowEqual ? start.isSameOrBefore(end) : start.isBefore(end);
}

/**
 * Return the number of days between two dates (absolute value).
 *
 * @param {Date|string} startDate
 * @param {Date|string} endDate
 * @returns {number|null}
 */
function daysBetween(startDate, endDate) {
  if (!startDate || !endDate) return null;
  const start = moment(startDate);
  const end = moment(endDate);
  if (!start.isValid() || !end.isValid()) return null;
  return Math.abs(end.diff(start, 'days'));
}

/**
 * Get the first and last day of a given month/year.
 *
 * @param {number} month - 1-based month.
 * @param {number} year
 * @returns {{ startDate: string, endDate: string }}
 */
function getMonthBounds(month, year) {
  const m = moment({ year, month: month - 1 }); // moment months are 0-indexed
  return {
    startDate: m.startOf('month').format(DATE_FORMAT),
    endDate: m.endOf('month').format(DATE_FORMAT),
  };
}

/**
 * Check whether a date string/object falls within an inclusive range.
 *
 * @param {Date|string} date
 * @param {Date|string} startDate
 * @param {Date|string} endDate
 * @returns {boolean}
 */
function isDateInRange(date, startDate, endDate) {
  if (!date || !startDate || !endDate) return false;
  const d = moment(date);
  const s = moment(startDate);
  const e = moment(endDate);
  if (!d.isValid() || !s.isValid() || !e.isValid()) return false;
  return d.isBetween(s, e, undefined, '[]');
}

/**
 * Parse a date string and return a native Date object (or null).
 *
 * @param {string} dateStr
 * @returns {Date|null}
 */
function parseDate(dateStr) {
  if (!dateStr) return null;
  const m = moment.tz(dateStr, [DATE_FORMAT, 'DD/MM/YYYY', 'MM/DD/YYYY', moment.ISO_8601], true, DEFAULT_TZ);
  return m.isValid() ? m.toDate() : null;
}

/**
 * Get current time as a JS Date in the configured timezone.
 * @returns {Date}
 */
function nowDate() {
  return moment().toDate();
}

/**
 * Get current timestamp formatted with timezone offset (e.g. 2026-06-25T14:30:00+05:30)
 * @returns {string}
 */
function nowISO() {
  return moment().format(ISO_TZ_FORMAT);
}

/**
 * Filename-friendly timestamp prefix (YYYY-MM-DD-HH-mm-ss)
 * @returns {string}
 */
function nowFilenamePrefix() {
  return moment().format('YYYY-MM-DD-HH-mm-ss');
}

module.exports = {
  getCurrentMonth,
  getCurrentYear,
  formatDate,
  formatDisplayDate,
  formatDateTime,
  isValidDateRange,
  daysBetween,
  getMonthBounds,
  isDateInRange,
  parseDate,
  DATE_FORMAT,
  DISPLAY_FORMAT,
  DATETIME_FORMAT,
  nowDate,
  nowISO,
  nowFilenamePrefix,
  DEFAULT_TZ,
};
