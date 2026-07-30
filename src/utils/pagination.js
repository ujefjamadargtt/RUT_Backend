'use strict';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

/**
 * Extract and sanitize pagination parameters from a request query string.
 *
 * Supports:
 *   ?page=2&limit=20
 *   ?page=2&pageSize=20   (alias for limit)
 *
 * @param {object} query - Express req.query object.
 * @returns {{ page: number, limit: number, offset: number }}
 */
function getPaginationParams(query = {}) {
  let page = parseInt(query.page, 10);
  let limit = parseInt(query.limit || query.pageSize, 10);

  if (isNaN(page) || page < 1) {
    page = DEFAULT_PAGE;
  }

  if (isNaN(limit) || limit < 1) {
    limit = DEFAULT_LIMIT;
  }

  // Cap at maximum to prevent runaway queries
  if (limit > MAX_LIMIT) {
    limit = MAX_LIMIT;
  }

  const offset = (page - 1) * limit;

  return { page, limit, offset };
}

/**
 * Build pagination metadata for a response envelope.
 *
 * @param {number} total  - Total number of records matching the query.
 * @param {number} page   - Current page number (1-based).
 * @param {number} limit  - Number of records per page.
 * @returns {{
 *   total: number,
 *   page: number,
 *   limit: number,
 *   totalPages: number,
 *   hasNext: boolean,
 *   hasPrev: boolean,
 * }}
 */
function getPaginationMeta(total, page, limit) {
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;

  return {
    total,
    page,
    limit,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}

/**
 * Build a Sequelize-compatible { limit, offset } clause directly.
 *
 * @param {object} query - Express req.query.
 * @returns {{ limit: number, offset: number }}
 */
function getSequelizePagination(query = {}) {
  const { limit, offset } = getPaginationParams(query);
  return { limit, offset };
}

module.exports = {
  getPaginationParams,
  getPaginationMeta,
  getSequelizePagination,
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
