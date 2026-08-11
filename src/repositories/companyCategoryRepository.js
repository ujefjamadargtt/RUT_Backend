'use strict';

const { CompanyCategory } = require('../models');

/**
 * Company Category Repository
 * Raw database access for the company_categories mapping table — provenance
 * bookkeeping only (which company adopted which default category, or a
 * custom category it created itself). Never read by reports/dashboard/
 * timesheet code — those keep reading service_categories directly.
 */

/**
 * Insert a company_categories mapping row.
 *
 * @param {object} data - { company_id, default_category_id (nullable), status }
 * @param {object} [options] - Sequelize options (e.g. { transaction })
 * @returns {Promise<CompanyCategory>}
 */
const create = async (data, options = {}) => {
  return CompanyCategory.create(data, options);
};

/**
 * Find a company's mapping row for a specific default category, if any.
 *
 * @param {number} companyId
 * @param {number} defaultCategoryId
 * @returns {Promise<CompanyCategory|null>}
 */
const findByCompanyAndDefault = async (companyId, defaultCategoryId) => {
  return CompanyCategory.findOne({
    where: { company_id: companyId, default_category_id: defaultCategoryId },
  });
};

module.exports = {
  create,
  findByCompanyAndDefault,
};
