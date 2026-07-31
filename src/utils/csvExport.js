'use strict';

/**
 * Minimal RFC 4180 CSV serializer — no external dependency needed for the
 * simple flat tabular exports the Employee Reports module produces.
 */

/**
 * Quote a single CSV field if it contains a comma, quote, or newline.
 * @param {*} value
 * @returns {string}
 */
function escapeField(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Build a CSV buffer from rows + column definitions.
 *
 * @param {Array<object>} rows
 * @param {Array<{ key: string, label: string }>} columns
 * @returns {Buffer}
 */
function toCsvBuffer(rows, columns) {
  const lines = [columns.map((c) => escapeField(c.label)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeField(row[c.key])).join(','));
  }
  return Buffer.from(lines.join('\r\n'), 'utf-8');
}

module.exports = { toCsvBuffer };
