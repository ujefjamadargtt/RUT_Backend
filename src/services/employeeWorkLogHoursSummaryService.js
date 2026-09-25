'use strict';

const { Op } = require('sequelize');
const { Employee } = require('../models');
const employeeRepository = require('../repositories/employeeRepository');
const employeeAccessControlService = require('./employeeAccessControlService');
const { intersectCompanyIdsWithEntity, intersectIdsWithBuHierarchy } = require('./companyAccessControlService');
const summaryRepository = require('../repositories/employeeWorkLogHoursSummaryRepository');
const dateHelper = require('../helpers/dateHelper');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const { parseIdList } = require('../utils/idListParser');

/**
 * Narrow an already-resolved companyIds[] (BU/role reach) by this report's
 * entity_ids/company_ids/business_unit_ids multi-select query params —
 * sent as literal, explicit fields now (not via the X-Company-Id header
 * mechanism most other reports use) — additive to the legacy singular
 * entityId. company_ids and business_unit_ids are accepted as equivalent
 * BU-narrowing filters (both compose via intersection when given together,
 * matching this report's own field naming as sent by the frontend). Both
 * narrow, never widen; an id outside the caller's own reach silently yields
 * no data for that id, never an error.
 *
 * @param {number[]} companyIds
 * @param {object} query
 * @returns {Promise<number[]>}
 */
async function applyEntityBuFilters(companyIds, query) {
  const entityId = query.entityId ? parseInt(query.entityId, 10) : undefined;
  let scoped = await intersectCompanyIdsWithEntity(companyIds, parseIdList(query.entity_ids) ?? entityId);
  scoped = await intersectIdsWithBuHierarchy(scoped, parseIdList(query.company_ids));
  scoped = await intersectIdsWithBuHierarchy(scoped, parseIdList(query.business_unit_ids));
  return scoped;
}

const asNumber = (value) => Number.parseFloat(value) || 0;

function resolvePeriod(query) {
  if (query.date) return { startDate: query.date, endDate: query.date, period: { type: 'date', date: query.date } };
  const { startDate, endDate } = dateHelper.getMonthBounds(query.month, query.year);
  return { startDate, endDate, period: { type: 'month', month: query.month, year: query.year } };
}

/**
 * Builds the same data-driven Employee visibility scope used by Employee
 * Master. It is evaluated once per reachable BU and unioned, because reports
 * intentionally support a multi-BU caller with no selected Global BU.
 */
async function resolveAuthorizedEmployeeIds(authContext, companyIds) {
  if (!companyIds.length) return [];

  const accessScopes = await Promise.all(companyIds.map((companyId) => (
    employeeAccessControlService.resolveEmployeeAccessWhere({ ...authContext, companyId })
  )));
  const companyScope = await employeeRepository.employeeScope(companyIds);
  const employees = await Employee.findAll({
    where: {
      [Op.and]: [
        { is_deleted: false },
        { [Op.or]: accessScopes },
        companyScope,
      ],
    },
    attributes: ['id'],
    raw: true,
  });
  return employees.map((employee) => employee.id);
}

async function getSummary(query, authContext, companyIds) {
  const { startDate, endDate, period } = resolvePeriod(query);
  companyIds = await applyEntityBuFilters(companyIds, query);
  let employeeIds = await resolveAuthorizedEmployeeIds(authContext, companyIds);

  if (query.employeeId) {
    employeeIds = employeeIds.filter((id) => id === query.employeeId);
  }

  const { page, limit, offset } = getPaginationParams(query);
  const { rows, count } = await summaryRepository.getSummary({
    employeeIds,
    startDate,
    endDate,
    search: query.search || undefined,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    limit,
    offset,
  });

  return {
    period,
    data: rows.map((row) => ({ ...row, total_hours: asNumber(row.total_hours) })),
    meta: getPaginationMeta(count, page, limit),
  };
}

async function getDetails(employeeId, query, authContext, companyIds) {
  const { startDate, endDate, period } = resolvePeriod(query);
  companyIds = await applyEntityBuFilters(companyIds, query);
  const employeeIds = await resolveAuthorizedEmployeeIds(authContext, companyIds);
  if (!employeeIds.includes(employeeId)) {
    const err = new Error('Employee not found.');
    err.statusCode = 404;
    throw err;
  }

  const employee = await Employee.findOne({
    where: { id: employeeId, is_deleted: false },
    attributes: ['id', 'full_name', 'employee_code'],
    raw: true,
  });
  if (!employee) {
    const err = new Error('Employee not found.');
    err.statusCode = 404;
    throw err;
  }

  const { page, limit, offset } = getPaginationParams(query);
  const result = await summaryRepository.getDetails({ employeeId, startDate, endDate, limit, offset });
  return {
    period,
    employee: {
      id: employee.id,
      full_name: employee.full_name,
      employee_code: employee.employee_code,
    },
    total_hours: asNumber(result.totalHours),
    work_log_count: result.workLogCount,
    entries: result.entries.map((entry) => ({ ...entry, hours: asNumber(entry.hours) })),
    meta: getPaginationMeta(result.count, page, limit),
  };
}

module.exports = { getSummary, getDetails, resolvePeriod, resolveAuthorizedEmployeeIds };
