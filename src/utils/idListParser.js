'use strict';

/**
 * Parse a multi-select ID filter from a query param. Accepts a single value
 * ("175"), a comma-separated list ("175,178,179"), or an array (repeated
 * query keys, e.g. employeeId=175&employeeId=178). Shared across Reports
 * and List/Master services — extracted from reportService.js so List/Master
 * (entityIds/businessUnitIds) doesn't need to import a Report-layer module
 * just to reuse this parser.
 *
 * @param {string|string[]|number|undefined} value
 * @returns {number[]|undefined} undefined when no usable ID was provided
 */
function parseIdList(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const ids = raw
    .map((v) => parseInt(String(v).trim(), 10))
    .filter((n) => !isNaN(n));
  return ids.length > 0 ? ids : undefined;
}

module.exports = { parseIdList };
