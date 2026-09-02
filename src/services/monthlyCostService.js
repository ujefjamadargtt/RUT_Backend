'use strict';

const { Op } = require('sequelize');
const { sequelize } = require('../models');
const monthlyCostRepository = require('../repositories/monthlyCostRepository');
const { Employee, Company } = require('../models');
const companyAccessControlService = require('./companyAccessControlService');
const { createAuditLog } = require('../middlewares/auditLog');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const logger = require('../utils/logger');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

/**
 * Monthly Cost Service
 * Business logic for cost calculation, validation, and bulk operations.
 *
 * Key formulas:
 *   total_cost             = salary_cost + ops_cost
 *   per_hour_rate          = total_cost / working_hours  (default 176 h/month)
 */

const DEFAULT_WORKING_HOURS = 176;

/**
 * Round a number to 2 decimal places.
 * @param {number} value
 * @returns {number}
 */
const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

/**
 * Calculate derived cost fields given the raw inputs.
 *
 * @param {number} salaryCost
 * @param {number} opsCost
 * @param {number} workingHours
 * @returns {{ total_cost, per_hour_rate }}
 */
const calculateDerivedFields = (salaryCost, opsCost, workingHours) => {
  const totalCost = round2(parseFloat(salaryCost || 0) + parseFloat(opsCost || 0));
  const perHourRate = workingHours > 0 ? round2(totalCost / workingHours) : 0;

  return {
    total_cost: totalCost,
    per_hour_rate: perHourRate,
  };
};

// ─── getAll ────────────────────────────────────────────────────────────────────
/**
 * Paginated list of monthly cost records.
 *
 * @param {object} query
 * @returns {Promise<{ data: MonthlyCost[], meta: object }>}
 */
const getAll = async (query = {}, companyId) => {
  const { page, limit, offset } = getPaginationParams(query);

  const filters = {
    year: query.year || null,
    month: query.month || null,
    employee_id: query.employee_id || null,
    search: query.search || null,
    sortBy: query.sort_by || 'year',
    sortOrder: (query.sort_order || 'DESC').toUpperCase(),
    companyId,
  };

  const { rows, count } = await monthlyCostRepository.findAll(
    filters,
    { limit, offset },
    {}
  );

  const meta = getPaginationMeta(count, page, limit);

  return { data: rows, meta };
};

// ─── getById ───────────────────────────────────────────────────────────────────
/**
 * @param {number} id
 * @returns {Promise<MonthlyCost>}
 */
const getById = async (id, companyId) => {
  const record = await monthlyCostRepository.findById(id, companyId);

  if (!record) {
    const error = new Error('Monthly cost record not found.');
    error.statusCode = 404;
    throw error;
  }

  return record;
};

// ─── create ────────────────────────────────────────────────────────────────────
/**
 * Create a new monthly cost entry.
 *
 * Steps:
 * 1. Validate employee exists and is active.
 * 2. Guard duplicate employee + month + year.
 * 3. Calculate total_cost = salary_cost + ops_cost.
 * 4. Persist and audit.
 *
 * @param {object} data   - Validated request body
 * @param {number} userId
 * @param {string} ip
 * @returns {Promise<MonthlyCost>}
 */
const create = async (data, userId, ip = null, companyId) => {
  const { employee_id, month, year, salary_cost, ops_cost, billable_cost, working_hours } = data;

  // 1. Validate employee exists, is active, AND belongs to this company —
  // an employee_id from another company simply 404s, same as a genuinely
  // missing id.
  const employee = await Employee.findOne({
    where: { id: employee_id, company_id: companyId },
    attributes: ['id', 'full_name', 'status'],
  });

  if (!employee) {
    const error = new Error('Employee not found.');
    error.statusCode = 404;
    throw error;
  }

  if (employee.status !== 'active') {
    const error = new Error(
      `Employee "${employee.full_name}" is not active. Monthly costs can only be created for active employees.`
    );
    error.statusCode = 400;
    throw error;
  }

  // 2. Guard duplicate
  const existing = await monthlyCostRepository.findByEmployeeMonthYear(employee_id, month, year, companyId);
  if (existing) {
    const error = new Error(
      `A monthly cost record already exists for employee ID ${employee_id} for ${month}/${year}. Use PUT to update it.`
    );
    error.statusCode = 409;
    throw error;
  }

  // 3. Calculate derived fields
  const effectiveOpsCost = parseFloat(ops_cost || 0);
  const workingHoursValue = parseInt(working_hours || DEFAULT_WORKING_HOURS, 10);
  const { total_cost, per_hour_rate } = calculateDerivedFields(
    salary_cost,
    effectiveOpsCost,
    workingHoursValue
  );

  const payload = {
    employee_id,
    month,
    year,
    salary_cost: round2(parseFloat(salary_cost || 0)),
    ops_cost: round2(effectiveOpsCost),
    total_cost,
    billable_cost: billable_cost !== undefined ? round2(parseFloat(billable_cost || 0)) : null,
    company_id: companyId,
    created_by: userId,
    updated_by: userId,
  };

  const record = await monthlyCostRepository.create(payload);

  // Audit log
  await createAuditLog(
    userId,
    'CREATE',
    'monthly_costs',
    record.id,
    null,
    {
      employee_id: record.employee_id,
      month: record.month,
      year: record.year,
      salary_cost: record.salary_cost,
      ops_cost: record.ops_cost,
      total_cost: record.total_cost,
      per_hour_rate,
    },
    ip
  );

  return monthlyCostRepository.findById(record.id, companyId);
};

// ─── update ────────────────────────────────────────────────────────────────────
/**
 * Update a monthly cost record and recalculate all derived fields.
 *
 * If salary_cost or ops_cost change, recalculate total_cost.
 *
 * @param {number} id
 * @param {object} data
 * @param {number} userId
 * @param {string} ip
 * @returns {Promise<MonthlyCost>}
 */
const update = async (id, data, userId, ip = null, companyId) => {
  const existing = await monthlyCostRepository.findById(id, companyId);

  if (!existing) {
    const error = new Error('Monthly cost record not found.');
    error.statusCode = 404;
    throw error;
  }

  // If changing employee/month/year, check for duplicate
  const targetEmployeeId = data.employee_id || existing.employee_id;
  const targetMonth = data.month || existing.month;
  const targetYear = data.year || existing.year;

  const isKeyChanging =
    (data.employee_id && data.employee_id !== existing.employee_id) ||
    (data.month && data.month !== existing.month) ||
    (data.year && data.year !== existing.year);

  if (isKeyChanging) {
    const duplicate = await monthlyCostRepository.findByEmployeeMonthYear(
      targetEmployeeId,
      targetMonth,
      targetYear,
      companyId
    );
    if (duplicate && duplicate.id !== id) {
      const error = new Error(
        `A monthly cost record already exists for employee ID ${targetEmployeeId} for ${targetMonth}/${targetYear}.`
      );
      error.statusCode = 409;
      throw error;
    }
  }

  // Recalculate derived fields
  const newSalaryCost = data.salary_cost !== undefined
    ? parseFloat(data.salary_cost)
    : parseFloat(existing.salary_cost || 0);

  const newOpsCost = data.ops_cost !== undefined
    ? parseFloat(data.ops_cost)
    : parseFloat(existing.ops_cost || 0);

  const workingHoursValue = parseInt(data.working_hours || DEFAULT_WORKING_HOURS, 10);
  const { total_cost, per_hour_rate } = calculateDerivedFields(
    newSalaryCost,
    newOpsCost,
    workingHoursValue
  );

  const oldValues = {
    employee_id: existing.employee_id,
    month: existing.month,
    year: existing.year,
    salary_cost: existing.salary_cost,
    ops_cost: existing.ops_cost,
    total_cost: existing.total_cost,
  };

  const updatePayload = {
    employee_id: targetEmployeeId,
    month: targetMonth,
    year: targetYear,
    salary_cost: round2(newSalaryCost),
    ops_cost: round2(newOpsCost),
    total_cost,
    updated_by: userId,
  };

  if (data.billable_cost !== undefined) {
    updatePayload.billable_cost = round2(parseFloat(data.billable_cost || 0));
  }

  await monthlyCostRepository.update(id, updatePayload, companyId);

  const updated = await monthlyCostRepository.findById(id, companyId);

  // Audit log
  await createAuditLog(
    userId,
    'UPDATE',
    'monthly_costs',
    id,
    oldValues,
    {
      employee_id: updated.employee_id,
      month: updated.month,
      year: updated.year,
      salary_cost: updated.salary_cost,
      ops_cost: updated.ops_cost,
      total_cost: updated.total_cost,
      per_hour_rate,
    },
    ip
  );

  return updated;
};

// ─── delete ────────────────────────────────────────────────────────────────────
/**
 * Hard-delete a monthly cost record.
 *
 * @param {number} id
 * @param {number} userId
 * @param {string} ip
 * @returns {Promise<void>}
 */
const deleteCost = async (id, userId, ip = null, companyId) => {
  const existing = await monthlyCostRepository.findById(id, companyId);

  if (!existing) {
    const error = new Error('Monthly cost record not found.');
    error.statusCode = 404;
    throw error;
  }

  await monthlyCostRepository.delete(id, companyId);

  // Audit log
  await createAuditLog(
    userId,
    'DELETE',
    'monthly_costs',
    id,
    {
      employee_id: existing.employee_id,
      month: existing.month,
      year: existing.year,
      salary_cost: existing.salary_cost,
      total_cost: existing.total_cost,
    },
    null,
    ip
  );
};

/**
 * Delete one or many monthly cost records in a single call.
 * Pass an array with a single ID to delete just one row, or many IDs to
 * delete multiple rows at once.
 *
 * @param {number[]} ids
 * @param {number}   userId
 * @param {string}   [ip]
 * @returns {Promise<{ deletedCount: number, requestedIds: number[] }>}
 */
const deleteMany = async (ids, userId, ip = null, companyId) => {
  const uniqueIds = [...new Set((ids || []).map((v) => parseInt(v, 10)).filter((v) => !isNaN(v) && v > 0))];

  if (uniqueIds.length === 0) {
    const error = new Error('ids must be a non-empty array of valid monthly cost IDs.');
    error.statusCode = 422;
    throw error;
  }

  const deletedCount = await monthlyCostRepository.deleteByIds(uniqueIds, companyId);

  if (deletedCount === 0) {
    const error = new Error('No matching monthly cost record(s) found to delete.');
    error.statusCode = 404;
    throw error;
  }

  await createAuditLog(
    userId,
    'DELETE',
    'monthly_costs',
    null,
    null,
    { deletedIds: uniqueIds, deletedCount },
    ip
  );

  return { deletedCount, requestedIds: uniqueIds };
};

/**
 * Delete an entire "monthly sheet" of cost data — every monthly_costs record
 * (across all employees) for the given month(s)/year(s) — in a single call.
 * Pass a single-element array to clear one month, or several to clear many.
 *
 * NOTE: Unlike the timesheet import flow, Monthly Cost imports do not persist
 * an uploaded-file reference per record — the Excel file is deleted from disk
 * immediately after each import finishes (see importFromExcel below), and no
 * "import batch" table exists for this module. So there is no separate
 * physical file left on disk to remove here; deleting the month's DB rows is
 * the complete equivalent operation for this module.
 *
 * @param {{month:number, year:number}[]} months
 * @param {number} userId
 * @param {string} [ip]
 * @returns {Promise<{ deletedCount: number, monthYears: string[] }>}
 */
const deleteByMonth = async (months, userId, ip = null, companyId) => {
  if (!Array.isArray(months) || months.length === 0) {
    const error = new Error('months must be a non-empty array of { month, year } objects.');
    error.statusCode = 422;
    throw error;
  }

  const monthYears = [
    ...new Set(
      months
        .map((m) => monthlyCostRepository.formatMonthYear(m.month, m.year))
        .filter(Boolean)
    ),
  ];

  if (monthYears.length === 0) {
    const error = new Error('Each entry in months must have a valid month (1-12) and year.');
    error.statusCode = 422;
    throw error;
  }

  const deletedCount = await monthlyCostRepository.deleteByMonthYears(monthYears, companyId);

  if (deletedCount === 0) {
    const error = new Error('No monthly cost records found for the given month(s)/year(s).');
    error.statusCode = 404;
    throw error;
  }

  await createAuditLog(
    userId,
    'DELETE',
    'monthly_costs',
    null,
    null,
    { monthYears, deletedCount },
    ip
  );

  return { deletedCount, monthYears };
};

// ─── calculateForMonth ─────────────────────────────────────────────────────────
/**
 * Bulk recalculate total_cost for every record
 * in a given month/year.
 *
 * Algorithm:
 * 1. Fetch all records for the month.
 * 2. Calculate total_cost = salary_cost + ops_cost for each record.
 * 3. Persist all updates inside a single transaction.
 *
 * @param {number} month
 * @param {number} year
 * @param {number} userId
 * @param {string} ip
 * @param {number} [workingHours=176]
 * @returns {Promise<{ processed: number, updated: number, summary: object }>}
 */
const calculateForMonth = async (month, year, userId, ip = null, workingHours = DEFAULT_WORKING_HOURS, companyId) => {
  const records = await monthlyCostRepository.getBulkForMonth(month, year, companyId);

  if (!records || records.length === 0) {
    const error = new Error(`No monthly cost records found for ${month}/${year}.`);
    error.statusCode = 404;
    throw error;
  }

  const totalOpsCost = records.reduce(
    (sum, r) => sum + parseFloat(r.ops_cost || 0),
    0
  );

  const effectiveWorkingHours = parseInt(workingHours || DEFAULT_WORKING_HOURS, 10);

  let updatedCount = 0;
  const transaction = await sequelize.transaction();

  try {
    for (const record of records) {
      const salaryCost = parseFloat(record.salary_cost || 0);
      const opsCost = parseFloat(record.ops_cost || 0);
      const totalCost = round2(salaryCost + opsCost);

      await monthlyCostRepository.update(record.id, {
        total_cost: totalCost,
        updated_by: userId,
      }, companyId);

      updatedCount++;
    }

    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    logger.error('MonthlyCostService.calculateForMonth transaction failed', {
      month, year, error: error.message,
    });
    throw error;
  }

  const summary = {
    month,
    year,
    total_records: records.length,
    total_ops_cost: round2(totalOpsCost),
    working_hours: effectiveWorkingHours,
  };

  // Audit log for bulk operation
  await createAuditLog(
    userId,
    'BULK_CALCULATE',
    'monthly_costs',
    null,
    null,
    summary,
    ip
  );

  logger.info('MonthlyCostService.calculateForMonth completed', summary);

  return {
    processed: records.length,
    updated: updatedCount,
    summary,
  };
};

// ── importFromExcel ─────────────────────────────────────────────────────────────────────
/**
 * Parse "Month Year" cell value into { month, year }.
 * Accepts:
 *  - Excel serial date number (e.g. 45292 -> 2024-01)
 *  - "Jan 2025", "January 2025"
 *  - "01/2025", "1/2025"
 *  - "2025-01", "01-2025"
 *  - Plain number pairs handled via separate columns (not this field)
 *
 * @param {*} value
 * @returns {{ month: number, year: number }|null}
 */
const parseMonthYear = (value) => {
  if (value === null || value === undefined || value === '') return null;

  // Excel date serial number
  if (typeof value === 'number') {
    try {
      const date = XLSX.SSF.parse_date_code(value);
      if (date && date.m && date.y) {
        return { month: date.m, year: date.y };
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  const str = String(value).trim();

  // "Jan 2025" / "January 2025"
  const monthNames = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ];
  const shortNames = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

  const namedMatch = str.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (namedMatch) {
    const nameLower = namedMatch[1].toLowerCase();
    let m = monthNames.indexOf(nameLower);
    if (m === -1) m = shortNames.indexOf(nameLower);
    if (m !== -1) return { month: m + 1, year: parseInt(namedMatch[2], 10) };
  }

  // "01/2025" or "1/2025"
  const slashMatch = str.match(/^(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const m = parseInt(slashMatch[1], 10);
    const y = parseInt(slashMatch[2], 10);
    if (m >= 1 && m <= 12) return { month: m, year: y };
  }

  // "2025-01" (ISO style)
  const isoMatch = str.match(/^(\d{4})-(\d{1,2})$/);
  if (isoMatch) {
    const y = parseInt(isoMatch[1], 10);
    const m = parseInt(isoMatch[2], 10);
    if (m >= 1 && m <= 12) return { month: m, year: y };
  }

  // "01-2025"
  const dashMatch = str.match(/^(\d{1,2})-(\d{4})$/);
  if (dashMatch) {
    const m = parseInt(dashMatch[1], 10);
    const y = parseInt(dashMatch[2], 10);
    if (m >= 1 && m <= 12) return { month: m, year: y };
  }

  return null;
};

/**
 * Normalise a column-header string for flexible matching.
 * Strips whitespace, underscores, hyphens and lowercases.
 */
const normaliseHeader = (h) => String(h).replace(/[\s_\-]/g, '').toLowerCase();

/**
 * Import Monthly Cost records from an uploaded Excel (.xlsx) file.
 *
 * Expected columns (case-insensitive, spaces/underscores flexible):
 *   Employee ID | Month Year | Salary Cost | Ops Cost | Total Cost | Billable Cost
 *
 * Behaviour per row:
 *  - If a record for (employee_id, month, year) already exists  → UPDATE
 *  - If no record exists                                         → INSERT
 *  - Validation errors are collected and returned (row is skipped)
 *
 * The Business Unit every row is stamped with is the explicit
 * `business_unit_id` multipart field, not `req.companyId`/`X-Company-Id` —
 * required whenever the caller has any reachable Business Unit, and
 * validated against that reach (see
 * companyAccessControlService.resolveImportBusinessUnitId()). The caller is
 * expected to also send `X-Company-Id` set to the same value (that's what
 * populates `req.companyId` for a BU-scoped actor), but `business_unit_id`
 * is the one actually used to scope employee lookups and stamp rows here.
 *
 * @param {string} filePath     Absolute path to the uploaded Excel file
 * @param {number} userId
 * @param {string} [ip]
 * @param {object} req - the request object; used for { body.business_unit_id, companyId, hierarchyRank, employeeId }
 * @returns {Promise<{ imported: number, updated: number, failed: number, errors: object[], summary: object[] }>}
 */
const importFromExcel = async (filePath, userId, ip = null, req) => {
  const bodyBusinessUnitId = req.body && req.body.business_unit_id
    ? parseInt(req.body.business_unit_id, 10)
    : undefined;
  const companyId = await companyAccessControlService.resolveImportBusinessUnitId(
    { companyId: req.companyId, hierarchyRank: req.hierarchyRank, employeeId: req.employeeId },
    bodyBusinessUnitId != null && !isNaN(bodyBusinessUnitId) ? bodyBusinessUnitId : null
  );

  // 1. Read workbook
  let workbook;
  try {
    workbook = XLSX.readFile(filePath);
  } catch (err) {
    const error = new Error(`Failed to read Excel file: ${err.message}`);
    error.statusCode = 422;
    throw error;
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    const error = new Error('The uploaded Excel file contains no sheets.');
    error.statusCode = 422;
    throw error;
  }

  const sheet = workbook.Sheets[sheetName];
  // Convert to array-of-objects; raw: false so dates come as strings
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: false });

  // Also read with raw: true so we can detect serial date numbers
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true });

  if (!rows || rows.length === 0) {
    const error = new Error('The Excel sheet is empty or has no data rows.');
    error.statusCode = 422;
    throw error;
  }

  if (rows.length > 500) {
    const error = new Error(`Too many rows: ${rows.length}. Maximum allowed is 500 per import.`);
    error.statusCode = 422;
    throw error;
  }

  // 2. Map headers flexibly
  const headerMap = {};
  const sampleKeys = Object.keys(rows[0] || {});
  const COLUMN_ALIASES = {
    employee_code: ['employeecode', 'empcode', 'empid', 'employeeid', 'id', 'employee code', 'emp code', 'emp id'],
    // allow employee name variants: "name", "employee", "employee name", "emp name"
    employee_name: ['name', 'employee', 'employeename', 'empname', 'empname'],
    month_year:    ['monthyear', 'monthyr', 'period', 'month/year'],
    salary_cost:   ['salarycost', 'salary', 'salcost', 'salarycost'],
    ops_cost:      ['opscost', 'operationalcost', 'opcost'],
    total_cost:    ['totalcost', 'total'],
    billable_cost: ['billablecost', 'billable', 'billablehours'],
  };

  for (const key of sampleKeys) {
    const norm = normaliseHeader(key);
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (aliases.includes(norm) && !headerMap[field]) {
        headerMap[field] = key; // original header name
      }
    }
  }

  // Validate required columns present
  // Require Month Year and Salary Cost. Employee identifier must be employee code or employee name.
  const missingCols = [];
  if (!headerMap.month_year) missingCols.push('month_year');
  if (!headerMap.salary_cost) missingCols.push('salary_cost');
  if (!headerMap.employee_code && !headerMap.employee_name) missingCols.push('employee identifier (Employee Code or Employee Name)');

  if (missingCols.length > 0) {
    const error = new Error(
      `Required column(s) not found in the Excel file: ${missingCols.join(', ')}. ` +
      `Please include: Employee Code (or Employee Name), Month Year, Salary Cost.`
    );
    error.statusCode = 422;
    throw error;
  }

  // 2b. Pre-scan for duplicate employee+month/year combinations within this
  // file (reporting only — does not block processing). Keyed by employee
  // identifier + month/year rather than identifier alone, since a single
  // file can legitimately cover multiple months for the same employee.
  const duplicateKeyMap = new Map(); // "identifier|month|year" -> [rowNum, ...]
  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2;
    const row = rows[i];
    const rawRow = rawRows[i];

    let identifier = null;
    if (headerMap.employee_code) {
      const v = row[headerMap.employee_code];
      identifier = v !== null && v !== '' ? String(v).trim().toLowerCase() : null;
    }
    if (!identifier && headerMap.employee_name) {
      const v = row[headerMap.employee_name];
      identifier = v !== null && v !== '' ? String(v).trim().toLowerCase() : null;
    }
    if (!identifier) continue;

    const rawMonthYearValue = rawRow[headerMap.month_year];
    const parsedMY = parseMonthYear(
      typeof rawMonthYearValue === 'number' ? rawMonthYearValue : row[headerMap.month_year]
    );
    if (!parsedMY) continue;

    const key = `${identifier}|${parsedMY.month}|${parsedMY.year}`;
    if (!duplicateKeyMap.has(key)) duplicateKeyMap.set(key, []);
    duplicateKeyMap.get(key).push(rowNum);
  }

  const duplicateRowNumbers = new Set();
  const duplicates = [];
  for (const [key, rowNums] of duplicateKeyMap) {
    if (rowNums.length > 1) {
      const [identifier, dupMonth, dupYear] = key.split('|');
      duplicates.push({
        employee_identifier: identifier,
        month: parseInt(dupMonth, 10),
        year: parseInt(dupYear, 10),
        rows: rowNums,
        occurrences: rowNums.length,
      });
      rowNums.forEach((r) => duplicateRowNumbers.add(r));
    }
  }

  if (duplicates.length > 0) {
    logger.warn('MonthlyCostService.importFromExcel duplicate employee+month/year rows detected', {
      duplicateCount: duplicates.length,
      duplicates,
    });
  }

  // 3. Process rows
  const results = [];
  let imported = 0;
  let updated  = 0;
  let failed   = 0;

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2; // 1-based, +1 for header row
    const row    = rows[i];
    const rawRow = rawRows[i];
    const rowErrors = [];
    // Declared here (not just inside the try block below) so the catch
    // block's error log can reference it — a `const` declared inside the
    // try was out of scope in the catch, throwing its own ReferenceError
    // and masking whatever the real dbErr actually was.
    let employeeId = null;

    // — employee identifier: prefer employee code, fall back to employee name
    let employeeCode = null;
    let employeeNameProvided = null;
    if (headerMap.employee_code) {
      const rawEmpCode = row[headerMap.employee_code];
      employeeCode = rawEmpCode !== null && rawEmpCode !== '' ? String(rawEmpCode).trim() : null;
    }

    if (!employeeCode && headerMap.employee_name) {
      const rawEmpName = row[headerMap.employee_name];
      employeeNameProvided = rawEmpName !== null && rawEmpName !== '' ? String(rawEmpName).trim() : null;
    }

    // — month_year: try raw value first (handles Excel date serials)
    const rawMonthYearValue = rawRow[headerMap.month_year];
    const parsed = parseMonthYear(
      typeof rawMonthYearValue === 'number' ? rawMonthYearValue : row[headerMap.month_year]
    );
    if (!parsed) {
      rowErrors.push(
        `Month Year "${row[headerMap.month_year]}" is not a valid format. ` +
        `Use: "Jan 2025", "01/2025", or "2025-01".`
      );
    }

    const { month, year } = parsed || {};

    // Year range check
    if (year && (year < 2020 || year > 2100)) {
      rowErrors.push(`Year ${year} is out of range (2020–2100).`);
    }

    // — cost fields
    const parseOptionalCost = (key, label) => {
      if (!headerMap[key]) return null; // column not in file → treat as not provided
      const val = row[headerMap[key]];
      if (val === null || val === '' || val === undefined) return null;
      const num = parseFloat(String(val).replace(/[,\s]/g, ''));
      if (isNaN(num) || num < 0) {
        rowErrors.push(`${label} must be a non-negative number (got "${val}").`);
        return null;
      }
      return Math.round(num * 100) / 100;
    };

    const salaryCost   = parseOptionalCost('salary_cost',   'Salary Cost');
    const opsCost      = parseOptionalCost('ops_cost',      'Ops Cost');
    const totalCost    = parseOptionalCost('total_cost',    'Total Cost');
    const billableCost = parseOptionalCost('billable_cost', 'Billable Cost');

    if (salaryCost === null && !rowErrors.length) {
      rowErrors.push('Salary Cost is required and must be a non-negative number.');
    }

    // Skip row if validation failed
    if (rowErrors.length > 0) {
      failed++;
      logger.warn('MonthlyCostService.importFromExcel row validation failed', {
        rowNum, errors: rowErrors, row,
      });
      results.push({ row: rowNum, status: 'error', errors: rowErrors, data: row, duplicate_in_file: duplicateRowNumbers.has(rowNum) });
      continue;
    }

    // — Verify employee exists in DB (active only)
    try {
      // An employee created after the Employee-Business-Unit redesign never
      // gets employees.company_id populated — their Company/BU membership
      // lives exclusively in employee_business_units. Matching on
      // company_id alone wrongly rejects such an employee for THIS Business
      // Unit even when they hold an active membership row for it (confirmed
      // live: EMP-45 "Jack", company_id NULL, active employee_business_units
      // row for BU 89 — passed preview but failed import with "not found"
      // until this OR was added). Same pattern as
      // timesheetService.validateRows()'s employee lookup.
      const businessUnitScope = {
        [Op.or]: [{ company_id: companyId }, { '$businessUnits.id$': companyId }],
      };
      const businessUnitInclude = [
        { model: Company, as: 'businessUnits', attributes: [], through: { attributes: [] } },
      ];

      let employee = null;
      if (employeeCode) {
        employee = await Employee.findOne({
          where: {
            [Op.and]: [
              sequelize.where(
                sequelize.fn('lower', sequelize.col('employee_code')),
                employeeCode.toLowerCase()
              ),
              businessUnitScope,
            ],
          },
          include: businessUnitInclude,
          attributes: ['id', 'full_name', 'employee_code', 'status'],
          // Without this, Sequelize wraps findOne's implicit LIMIT 1 in a
          // subquery that the WHERE clause's `$businessUnits.id$` reference
          // can't resolve against ("missing FROM-clause entry for table
          // businessUnits") — confirmed live. findAll with the same
          // where/include (no limit) doesn't need this, which is why
          // timesheetService.validateRows()'s sibling lookup didn't hit it.
          subQuery: false,
        });
      } else if (employeeNameProvided) {
        employee = await Employee.findOne({
          where: {
            [Op.and]: [
              sequelize.where(sequelize.fn('lower', sequelize.col('full_name')), employeeNameProvided.toLowerCase()),
              businessUnitScope,
            ],
          },
          include: businessUnitInclude,
          attributes: ['id', 'full_name', 'employee_code', 'status'],
          subQuery: false,
        });
      }

      if (!employee) {
        failed++;
        const notFoundError = employeeCode
          ? `Employee with code "${employeeCode}" was not found in the system.`
          : employeeNameProvided
            ? `Employee "${employeeNameProvided}" not found.`
            : 'Employee identifier not found.';
        logger.warn('MonthlyCostService.importFromExcel employee not found', {
          rowNum, employeeCode, employeeNameProvided, error: notFoundError,
        });
        results.push({ row: rowNum, status: 'error', errors: [notFoundError], data: row, duplicate_in_file: duplicateRowNumbers.has(rowNum) });
        continue;
      }

      if (employee.status !== 'active') {
        failed++;
        logger.warn('MonthlyCostService.importFromExcel employee not active', {
          rowNum, employeeId: employee.id, employeeCode: employee.employee_code, status: employee.status,
        });
        results.push({ row: rowNum, status: 'error', errors: [`Employee "${employee.full_name}" is not active.`], data: row, duplicate_in_file: duplicateRowNumbers.has(rowNum) });
        continue;
      }

      // — Upsert: check existing record
      employeeId = employee.id;
      const existing = await monthlyCostRepository.findByEmployeeMonthYear(employeeId, month, year, companyId);

      const payload = {
        employee_id:   employeeId,
        month,
        year,
        salary_cost:   salaryCost,
        ops_cost:      opsCost !== null ? opsCost : (existing ? existing.ops_cost : 0),
        total_cost:    totalCost !== null ? totalCost : null,
        billable_cost: billableCost !== null ? billableCost : (existing ? existing.billable_cost : null),
        company_id:    companyId,
        updated_by:    userId,
      };

      // If total_cost not provided in Excel, leave it as-is (don't recalculate)
      if (totalCost === null && !existing) {
        // For a new record, if total_cost is missing, compute simple sum
        payload.total_cost = round2((salaryCost || 0) + (opsCost || 0));
      }

      if (existing) {
        await monthlyCostRepository.update(existing.id, payload, companyId);
        updated++;
        results.push({
          row: rowNum,
          status: 'updated',
          employee_id: employeeId,
          month,
          year,
          record_id: existing.id,
          duplicate_in_file: duplicateRowNumbers.has(rowNum),
        });
      } else {
        payload.created_by = userId;
        const created = await monthlyCostRepository.create(payload);
        imported++;
        results.push({
          row: rowNum,
          status: 'imported',
          employee_id: employeeId,
          month,
          year,
          record_id: created.id,
          duplicate_in_file: duplicateRowNumbers.has(rowNum),
        });
      }
    } catch (dbErr) {
      failed++;
      logger.error('MonthlyCostService.importFromExcel row error', {
        rowNum, employeeId, error: dbErr.message,
      });
      results.push({ row: rowNum, status: 'error', errors: [dbErr.message], data: row, duplicate_in_file: duplicateRowNumbers.has(rowNum) });
    }
  }

  // 4. Cleanup uploaded file
  try {
    fs.unlinkSync(filePath);
  } catch (_) { /* ignore cleanup errors */ }

  // 5. Audit log
  await createAuditLog(
    userId,
    'IMPORT_EXCEL',
    'monthly_costs',
    null,
    null,
    { total_rows: rows.length, imported, updated, failed },
    ip
  );

  logger.info('MonthlyCostService.importFromExcel completed', {
    total_rows: rows.length, imported, updated, failed,
  });

  if (failed > 0) {
    // Aggregate failure reasons so a large batch of failures is diagnosable
    // from the terminal at a glance, instead of scrolling through every row.
    const reasonCounts = {};
    for (const r of results) {
      if (r.status !== 'error') continue;
      for (const msg of r.errors) {
        reasonCounts[msg] = (reasonCounts[msg] || 0) + 1;
      }
    }
    logger.warn('MonthlyCostService.importFromExcel failure breakdown', {
      total_rows: rows.length,
      failed,
      reasonCounts,
    });
  }

  return {
    total_rows: rows.length,
    imported,
    updated,
    failed,
    duplicates,
    results,
  };
};

module.exports = {
  getAll,
  getById,
  create,
  update,
  delete: deleteCost,
  deleteMany,
  deleteByMonth,
  calculateForMonth,
  importFromExcel,
};