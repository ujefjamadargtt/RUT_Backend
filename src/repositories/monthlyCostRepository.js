'use strict';

const { Op } = require('sequelize');
const { MonthlyCost, Employee } = require('../models');
const logger = require('../utils/logger');

/**
 * Monthly Cost Repository
 * All direct Sequelize interactions for the monthly_costs table.
 */

const formatMonthYear = (month, year) => {
  const monthInt = parseInt(month, 10);
  const yearInt = parseInt(year, 10);
  if (!monthInt || !yearInt || monthInt < 1 || monthInt > 12) return null;
  return `${yearInt}-${String(monthInt).padStart(2, '0')}`;
};

const parseMonthYear = (monthOrMonthYear, year) => {
  if (year !== undefined && year !== null) {
    return formatMonthYear(monthOrMonthYear, year);
  }

  if (typeof monthOrMonthYear === 'string') {
    const s = monthOrMonthYear.trim();
    const canonicalMatch = s.match(/^(\d{4})-(\d{1,2})$/);
    const slashMatch = s.match(/^(\d{1,2})\/(\d{4})$/);
    const compactMatch = s.match(/^(\d{6})$/);
    if (canonicalMatch) return formatMonthYear(canonicalMatch[2], canonicalMatch[1]);
    if (slashMatch) return formatMonthYear(slashMatch[1], slashMatch[2]);
    if (compactMatch) return formatMonthYear(s.slice(4), s.slice(0, 4));
    return s;
  }

  if (typeof monthOrMonthYear === 'number' && monthOrMonthYear > 9999) {
    const v = String(monthOrMonthYear);
    return formatMonthYear(v.slice(4), v.slice(0, 4));
  }

  return null;
};

const normalizeMonthlyCostPayload = (data = {}) => {
  const payload = { ...data };
  if (!payload.month_year && payload.month && payload.year) {
    payload.month_year = formatMonthYear(payload.month, payload.year);
  }
  delete payload.month;
  delete payload.year;
  return payload;
};

// ─── Standard employee include ─────────────────────────────────────────────────
const employeeInclude = {
  model: Employee,
  as: 'employee',
  attributes: [
    'id',
    'employee_code',
    'full_name',
    'designation',
    'status',
  ],
};

/**
 * Retrieve a paginated, filtered, sorted list of monthly cost records.
 *
 * @param {object} filters          - { year, month, employee_id, search }
 * @param {{ limit, offset }} pagination
 * @param {{ sortBy, sortOrder }} sort
 * @returns {Promise<{ rows: MonthlyCost[], count: number }>}
 */
const findAll = async (filters = {}, pagination = {}, sort = {}) => {
  try {
    const where = { company_id: filters.companyId };

    if (filters.year) {
      where.month_year = { [Op.like]: `${parseInt(filters.year, 10)}-%` };
    }

    if (filters.month) {
      const monthSuffix = `-${String(parseInt(filters.month, 10)).padStart(2, '0')}`;
      where.month_year = filters.year
        ? formatMonthYear(filters.month, filters.year)
        : { [Op.like]: `%${monthSuffix}` };
    }

    if (filters.employee_id) {
      where.employee_id = parseInt(filters.employee_id, 10);
    }

    // Matches against the joined employee's full_name or employee_code.
    // Adding a `where` to the include forces it to an INNER JOIN
    // (required: true) only when actually searching, so non-search
    // requests keep the existing LEFT JOIN include unchanged.
    const include = filters.search
      ? [{
          ...employeeInclude,
          where: {
            [Op.or]: [
              { full_name: { [Op.iLike]: `%${filters.search}%` } },
              { employee_code: { [Op.iLike]: `%${filters.search}%` } },
            ],
          },
          required: true,
        }]
      : [employeeInclude];

    const sortColumnMap = {
      year: 'month_year',
      month: 'month_year',
      month_year: 'month_year',
      salary_cost: 'salary_cost',
      ops_cost: 'ops_cost',
      total_cost: 'total_cost',
      billable_cost: 'billable_cost',
      created_at: 'created_at',
      employee: 'employee',
    };
    const allowedSortColumns = Object.keys(sortColumnMap);
    const requestedSort = filters.sortBy || sort.sortBy;
    const sortBy = allowedSortColumns.includes(requestedSort)
      ? sortColumnMap[requestedSort]
      : sortColumnMap.month_year;
    const sortOrder = ['ASC', 'DESC'].includes(
      (filters.sortOrder || sort.sortOrder || '').toUpperCase()
    )
      ? (filters.sortOrder || sort.sortOrder).toUpperCase()
      : 'DESC';

    const order = [];
    if (sortBy === 'employee') {
      // full_name lives on the joined Employee association, not on
      // monthly_costs itself — Sequelize needs the include's model/alias
      // tuple form rather than a plain column name to order by it.
      order.push([{ model: Employee, as: 'employee' }, 'full_name', sortOrder]);
      order.push(['month_year', sortOrder]);
    } else if (sortBy === 'month_year') {
      order.push(['month_year', sortOrder]);
    } else {
      order.push([sortBy, sortOrder]);
      order.push(['month_year', sortOrder]);
    }

    const result = await MonthlyCost.findAndCountAll({
      where,
      include,
      order,
      limit: pagination.limit || 20,
      offset: pagination.offset || 0,
      distinct: true,
    });

    return result;
  } catch (error) {
    logger.error('MonthlyCostRepository.findAll error', { error: error.message });
    throw error;
  }
};

/**
 * Find a single monthly cost record by primary key.
 *
 * @param {number} id
 * @returns {Promise<MonthlyCost|null>}
 */
const findById = async (id, companyId) => {
  try {
    return await MonthlyCost.findOne({
      where: { id: parseInt(id, 10), company_id: companyId },
      include: [employeeInclude],
    });
  } catch (error) {
    logger.error('MonthlyCostRepository.findById error', { id, error: error.message });
    throw error;
  }
};

/**
 * Find a cost record by employee + month + year (unique combination).
 *
 * @param {number} employeeId
 * @param {number} month
 * @param {number} year
 * @param {number} companyId
 * @returns {Promise<MonthlyCost|null>}
 */
const findByEmployeeMonthYear = async (employeeId, month, year, companyId) => {
  try {
    const monthYear = formatMonthYear(month, year);
    return await MonthlyCost.findOne({
      where: {
        employee_id: parseInt(employeeId, 10),
        month_year: monthYear,
        company_id: companyId,
      },
      include: [employeeInclude],
    });
  } catch (error) {
    logger.error('MonthlyCostRepository.findByEmployeeMonthYear error', {
      employeeId, month, year, error: error.message,
    });
    throw error;
  }
};

/**
 * Create a new monthly cost record.
 *
 * @param {object} data
 * @returns {Promise<MonthlyCost>}
 */
const create = async (data) => {
  try {
    return await MonthlyCost.create(normalizeMonthlyCostPayload(data));
  } catch (error) {
    logger.error('MonthlyCostRepository.create error', { error: error.message });
    throw error;
  }
};

/**
 * Update a monthly cost record by id.
 *
 * @param {number} id
 * @param {object} data
 * @returns {Promise<{ affectedCount: number, record: MonthlyCost|null }>}
 */
const update = async (id, data, companyId) => {
  try {
    const where = { id: parseInt(id, 10) };
    if (companyId !== undefined) where.company_id = companyId;
    const [affectedCount, updatedRows] = await MonthlyCost.update(normalizeMonthlyCostPayload(data), {
      where,
      returning: true,
    });
    return { affectedCount, record: updatedRows ? updatedRows[0] : null };
  } catch (error) {
    logger.error('MonthlyCostRepository.update error', { id, error: error.message });
    throw error;
  }
};

/**
 * Hard-delete a monthly cost record by id.
 *
 * @param {number} id
 * @returns {Promise<number>} number of rows deleted
 */
const deleteCost = async (id, companyId) => {
  try {
    return await MonthlyCost.destroy({
      where: { id: parseInt(id, 10), company_id: companyId },
    });
  } catch (error) {
    logger.error('MonthlyCostRepository.delete error', { id, error: error.message });
    throw error;
  }
};

/**
 * Hard-delete multiple monthly cost records by their IDs.
 * Used by the bulk-delete API — works for a single ID (array of length 1)
 * as well as many IDs at once.
 *
 * @param {number[]} ids
 * @returns {Promise<number>} number of rows deleted
 */
const deleteByIds = async (ids, companyId) => {
  try {
    if (!ids || ids.length === 0) return 0;
    return await MonthlyCost.destroy({
      where: { id: { [Op.in]: ids.map((id) => parseInt(id, 10)) }, company_id: companyId },
    });
  } catch (error) {
    logger.error('MonthlyCostRepository.deleteByIds error', { ids, error: error.message });
    throw error;
  }
};

/**
 * Hard-delete ALL monthly cost records for one or more month_year periods,
 * scoped to one company. This is the "monthly sheet" equivalent for cost
 * data — every record that belongs to that month for THIS company (across
 * all of its employees) is removed in one call. Without the company_id
 * filter this would wipe every other company's records for the same
 * month_year too — this was a real, confirmed data-loss bug.
 *
 * @param {string[]} monthYears - e.g. ['2026-06', '2026-07']
 * @param {number} companyId
 * @returns {Promise<number>} number of rows deleted
 */
const deleteByMonthYears = async (monthYears, companyId) => {
  try {
    if (!monthYears || monthYears.length === 0) return 0;
    return await MonthlyCost.destroy({
      where: { month_year: { [Op.in]: monthYears }, company_id: companyId },
    });
  } catch (error) {
    logger.error('MonthlyCostRepository.deleteByMonthYears error', { monthYears, error: error.message });
    throw error;
  }
};

/**
 * Get all monthly cost records for a given month/year, scoped to one
 * company (used for bulk recalculation). Without the company_id filter this
 * would recalculate every other company's cost records too.
 *
 * @param {number} month
 * @param {number} year
 * @param {number} companyId
 * @returns {Promise<MonthlyCost[]>}
 */
const getBulkForMonth = async (monthOrMonthYear, year, companyId) => {
  try {
    const monthYear = parseMonthYear(monthOrMonthYear, year);

    return await MonthlyCost.findAll({
      where: {
        month_year: monthYear,
        company_id: companyId,
      },
      include: [employeeInclude],
      order: [['employee_id', 'ASC']],
    });
  } catch (error) {
    logger.error('MonthlyCostRepository.getBulkForMonth error', {
      month: monthOrMonthYear, year, error: error.message,
    });
    throw error;
  }
};

module.exports = {
  findAll,
  findById,
  findByEmployeeMonthYear,
  create,
  update,
  delete: deleteCost,
  deleteByIds,
  deleteByMonthYears,
  getBulkForMonth,
  formatMonthYear,
  parseMonthYear,
};