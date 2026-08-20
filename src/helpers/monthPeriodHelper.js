'use strict';

/**
 * Shared "YYYY-MM" month-string parsing for Cost Budget / Resource Budget —
 * the API contract for both accepts/returns a single `month` field as
 * "YYYY-MM", while the underlying tables store it as separate month/year
 * INT columns (mirrors service_po_monthly_budgets, the newest existing
 * month-storage convention in this project — see
 * database/migrations/20260853_create_service_po_monthly_budgets.sql).
 * Kept as its own isolated helper rather than added to dateHelper.js so
 * this feature never touches a shared utility other modules depend on.
 */

const MONTH_STRING_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * @param {string} value
 * @returns {boolean}
 */
function isValidMonthString(value) {
  return typeof value === 'string' && MONTH_STRING_PATTERN.test(value);
}

/**
 * @param {string} value - "YYYY-MM"
 * @returns {{ month: number, year: number }}
 */
function parseMonthString(value) {
  const [year, month] = value.split('-').map((part) => parseInt(part, 10));
  return { month, year };
}

/**
 * @param {number} month - 1-based
 * @param {number} year
 * @returns {string} "YYYY-MM"
 */
function toMonthString(month, year) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

module.exports = {
  MONTH_STRING_PATTERN,
  isValidMonthString,
  parseMonthString,
  toMonthString,
};
