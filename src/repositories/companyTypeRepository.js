'use strict';

const { CompanyType } = require('../models');

/**
 * Company Type Repository
 * Raw database access for the company_types mapping table — provenance
 * bookkeeping only, mirrors companyCategoryRepository.js. Never read by
 * reports/dashboard/timesheet code — those keep reading service_types
 * directly.
 */

/**
 * Insert a company_types mapping row.
 *
 * @param {object} data - { company_category_id, default_type_id (nullable), status }
 * @param {object} [options] - Sequelize options (e.g. { transaction })
 * @returns {Promise<CompanyType>}
 */
const create = async (data, options = {}) => {
  return CompanyType.create(data, options);
};

module.exports = {
  create,
};
