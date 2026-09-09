'use strict';

const xlsx = require('xlsx');
const { Op } = require('sequelize');
const { Employee } = require('../models');
const managerSelfServiceService = require('./managerSelfServiceService');
const employeeMonthlyWorkLogService = require('./employeeMonthlyWorkLogService');
const employeeRepository = require('../repositories/employeeRepository');
const managerEmployeeMappingRepository = require('../repositories/managerEmployeeMappingRepository');
const employeeTimesheetService = require('./employeeTimesheetService');
const dateHelper = require('../helpers/dateHelper');
const { createAuditLog } = require('../middlewares/auditLog');
const logger = require('../utils/logger');

/**
 * Manager Monthly Work Log — lets a Manager fill in a Monthly Work Log on
 * behalf of one of their own mapped Employees (Primary or Secondary — see
 * managerSelfServiceService.assertOwnEmployee, reused verbatim here so this
 * never drifts from the same ownership rule every other My Team action
 * already enforces).
 *
 * Every entry created this way is auto-approved (status: 'approved' at
 * insert, never 'pending') and restricted to the Employee's Main PO only —
 * hierarchy_node_id is not accepted (see
 * managerMonthlyWorkLogValidation.js's line schema and
 * employeeMonthlyWorkLogService.submitMonthlyWorkLog's allowHierarchyNode
 * option). This is deliberately the same underlying REPLACE-SAVE engine
 * Employee self-service's Monthly Work Log already uses (project mapping,
 * 176-hour cap, duplicate-line, and cross-BU company_id resolution are all
 * enforced there, once) — this file only adds the Manager-side ownership
 * gate and the auto-approve/creator-id override, exactly like
 * managerSelfServiceService's approve/reject/bulk-approve actions layer
 * their own gate onto employeeWorkLogRepository rather than reimplementing
 * it.
 *
 * A resubmit (same employee+month, different entries) REPLACEs the prior
 * Manager-filled entries the same way Employee self-service resubmission
 * does — this is how "edit" is satisfied; delete removes the whole month's
 * entries via deleteMonthlyWorkLogForEmployee.
 */

/**
 * @param {number} managerUserId
 * @param {number} employeeId
 * @param {number} companyId
 * @param {number} month
 * @param {number} year
 * @param {number|null} [hierarchyRank]
 * @param {number[]} [callerBuIds]
 * @returns {Promise<object>} same shape as employeeMonthlyWorkLogService.getMonthlyWorkLog
 */
const getMonthlyWorkLogForEmployee = async (managerUserId, employeeId, companyId, month, year, hierarchyRank = null, callerBuIds = []) => {
  await managerSelfServiceService.assertOwnEmployee(managerUserId, employeeId, companyId, hierarchyRank, callerBuIds);

  return employeeMonthlyWorkLogService.getMonthlyWorkLog(employeeId, companyId, month, year);
};

/**
 * Submit (create or replace) the Monthly Work Log for one of the Manager's
 * own mapped Employees. Auto-approved, Main-PO-only — see this file's
 * header doc.
 *
 * @param {number} managerUserId
 * @param {number} employeeId
 * @param {number} companyId
 * @param {object} data - { month, year, entries: [{ service_po_id, sub_project_id?, hours, description }] }
 * @param {number} actorId - the Manager's own id, recorded as created_by/updated_by and as the audit log actor
 * @param {string} ipAddress
 * @param {number|null} [hierarchyRank]
 * @param {number[]} [callerBuIds]
 * @returns {Promise<object>} same shape as employeeMonthlyWorkLogService.getMonthlyWorkLog
 */
const submitMonthlyWorkLogForEmployee = async (managerUserId, employeeId, companyId, data, actorId, ipAddress, hierarchyRank = null, callerBuIds = []) => {
  await managerSelfServiceService.assertOwnEmployee(managerUserId, employeeId, companyId, hierarchyRank, callerBuIds);

  const result = await employeeMonthlyWorkLogService.submitMonthlyWorkLog(employeeId, companyId, data, {
    creatorId: actorId,
    forceApproved: true,
    allowHierarchyNode: false,
  });

  await createAuditLog(
    actorId,
    'CREATE',
    'employee_work_logs',
    null,
    null,
    { employee_id: employeeId, month: data.month, year: data.year, entry_count: (data.entries || []).length, status: 'approved' },
    ipAddress
  );

  logger.info('Manager submitted Monthly Work Log for Employee', {
    managerUserId, employeeId, month: data.month, year: data.year, actorId,
  });

  return result;
};

/**
 * Delete the Monthly Work Log (every entry for that month, Daily or
 * Monthly) for one of the Manager's own mapped Employees.
 *
 * @param {number} managerUserId
 * @param {number} employeeId
 * @param {number} companyId
 * @param {number} month
 * @param {number} year
 * @param {number|null} [hierarchyRank]
 * @param {number[]} [callerBuIds]
 * @returns {Promise<void>}
 */
const deleteMonthlyWorkLogForEmployee = async (managerUserId, employeeId, companyId, month, year, hierarchyRank = null, callerBuIds = []) => {
  await managerSelfServiceService.assertOwnEmployee(managerUserId, employeeId, companyId, hierarchyRank, callerBuIds);

  await employeeMonthlyWorkLogService.deleteMonthlyWorkLog(employeeId, companyId, month, year);

  logger.info('Manager deleted Monthly Work Log for Employee', { managerUserId, employeeId, month, year });
};

// ── Bulk Excel Upload ────────────────────────────────────────────────────
//
// An Excel/CSV alternative to the manual form above, for filling in
// several Employees' Monthly Work Log in one go. Columns: Employee Code,
// Employee Name, Service PO Name, Hours, Description (optional) — all but
// Description are required. One month per upload (month/year are separate
// form fields, not sheet columns).
//
// Validated in two GLOBAL gates across the WHOLE file, each one covering
// every row before the next gate runs at all — this is deliberately NOT a
// per-row "skip invalid, import the rest" import (unlike
// employeeImportService.js): a single bad row blocks the entire file, so a
// manager never ends up with a partially-applied upload.
//
//   Gate 1 (ownership) — every row's Employee Code must resolve to an
//   active Employee this Manager is the PRIMARY Manager of. This is
//   deliberately STRICTER than the manual single-employee form above
//   (assertOwnEmployee, which also allows a Secondary Manager) — a bulk
//   upload writes pre-approved data for potentially many employees at
//   once, so it's restricted to the one Manager HR set as PRIMARY at
//   Employee creation. If ANY row fails this, the whole file is rejected
//   here and Gate 2 never runs.
//
//   Gate 2 (Service PO) — every row's Service PO Name must resolve to one
//   of that Employee's actively-mapped Service POs (Main PO only — this
//   format has no hierarchy-node column either). If ANY row fails this,
//   the whole file is rejected and nothing is inserted.
//
// Only once both gates pass for every row does insertion happen: rows are
// grouped by Employee and REPLACE-SAVEd one Employee at a time through the
// exact same employeeMonthlyWorkLogService.submitMonthlyWorkLog(...,
// { forceApproved: true, allowHierarchyNode: false }) engine the manual
// form uses — so the 176-hour cap, duplicate-PO-in-one-month check, and
// auto-approve/creator-id override are all enforced there, once, never
// duplicated here. Each Employee's REPLACE-SAVE is its own transaction
// (submitMonthlyWorkLog's own internal transaction) — a DB failure on one
// Employee partway through a multi-employee upload does not roll back
// Employees already written earlier in the same request.

const ADMIN_TIER_MAX_RANK = 3;
const BU_ADMIN_RANK = 4;

function badRequestError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function validationError(message, details) {
  const err = new Error(message);
  err.statusCode = 422;
  if (details) err.details = details;
  return err;
}

// Flexible column-header -> field mapping, same normalise-then-lookup
// approach as employeeImportService.js's HEADER_MAP.
const HEADER_MAP = {
  'employee code': 'employee_code',
  'emp code': 'employee_code',
  'empcode': 'employee_code',
  'code': 'employee_code',
  'emp_code': 'employee_code',
  'employee name': 'employee_name',
  'emp name': 'employee_name',
  'name': 'employee_name',
  'full name': 'employee_name',
  'full_name': 'employee_name',
  'service po name': 'service_po_name',
  'service po': 'service_po_name',
  'servicepo': 'service_po_name',
  'spo name': 'service_po_name',
  'spo': 'service_po_name',
  'po name': 'service_po_name',
  'hours': 'hours',
  'hrs': 'hours',
  'hour': 'hours',
  'description': 'description',
  'desc': 'description',
  'remarks': 'description',
};

function normaliseHeader(raw) {
  return String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isBlank(v) {
  return v === null || v === undefined || v === '';
}

/**
 * Parse the first sheet of the uploaded Excel/CSV file into raw row
 * objects keyed by canonical field name — same header-detection strategy
 * as employeeImportService.parseEmployeeFile.
 */
function parseWorkLogFile(filePath) {
  const workbook = xlsx.readFile(filePath, { cellDates: false, raw: false });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const raw = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });

  if (!raw.length) return [];

  let headerRowIdx = -1;
  let mappedHeaders = [];

  for (let i = 0; i < Math.min(5, raw.length); i++) {
    const mapped = raw[i].map((h) => HEADER_MAP[normaliseHeader(h)] || null);
    if (mapped.filter(Boolean).length >= 3) {
      headerRowIdx = i;
      mappedHeaders = mapped;
      break;
    }
  }

  if (headerRowIdx === -1) {
    throw validationError(
      'Could not detect a valid header row. Expected columns like "Employee Code", "Employee Name", "Service PO Name", "Hours".'
    );
  }

  const rows = [];
  for (let i = headerRowIdx + 1; i < raw.length; i++) {
    const cells = raw[i];
    const row = { _rowNum: i + 1 };
    let hasData = false;

    mappedHeaders.forEach((field, colIdx) => {
      if (!field) return;
      const val = cells[colIdx];
      if (!isBlank(val)) hasData = true;
      row[field] = isBlank(val) ? '' : val;
    });

    if (!hasData) continue;
    rows.push(row);
  }

  return rows;
}

/**
 * Phase 0 (structural) — validate one raw row's own fields, independent of
 * any DB lookup. Employee Code, Employee Name, Service PO Name, Hours are
 * required; Description is optional.
 */
function validateRowShape(raw) {
  const errors = [];
  const data = {};

  const code = String(raw.employee_code || '').trim().toUpperCase();
  if (!code) errors.push('Employee Code is required.');
  else data.employee_code = code;

  const name = String(raw.employee_name || '').trim();
  if (!name) errors.push('Employee Name is required.');
  else data.employee_name = name;

  const poName = String(raw.service_po_name || '').trim();
  if (!poName) errors.push('Service PO Name is required.');
  else data.service_po_name = poName;

  if (isBlank(raw.hours)) {
    errors.push('Hours is required.');
  } else {
    const hours = parseFloat(String(raw.hours));
    if (isNaN(hours) || hours <= 0) {
      errors.push('Hours must be a positive number.');
    } else if (hours > employeeMonthlyWorkLogService.MONTHLY_HOUR_CAP) {
      errors.push(`Hours cannot exceed ${employeeMonthlyWorkLogService.MONTHLY_HOUR_CAP} per month.`);
    } else {
      data.hours = hours;
    }
  }

  data.description = String(raw.description || '').trim();

  return { errors, data };
}

/**
 * Bulk-upload (create/replace) the Monthly Work Log for several Employees
 * at once from an Excel/CSV file — see this section's header doc for the
 * two-gate validation flow.
 *
 * @param {number} managerUserId
 * @param {number} companyId
 * @param {string} filePath - path to the uploaded file (req.file.path)
 * @param {{ month: number|string, year: number|string }} period
 * @param {number} actorId - the Manager's own id (created_by/updated_by + audit actor)
 * @param {string} ipAddress
 * @param {number|null} [hierarchyRank]
 * @param {number[]} [callerBuIds]
 * @returns {Promise<{ month, year, employees_processed, total_rows, results }>}
 */
const bulkUploadMonthlyWorkLog = async (managerUserId, companyId, filePath, period, actorId, ipAddress, hierarchyRank = null, callerBuIds = []) => {
  const month = parseInt(period.month, 10);
  const year = parseInt(period.year, 10);
  if (!month || month < 1 || month > 12 || !year) {
    throw badRequestError('A valid month (1-12) and year are required.');
  }
  if (!dateHelper.isMonthlyLogEligible(month, year)) {
    throw validationError(
      'Monthly Work Log is only allowed for a month that has already ended, or on that month\'s last calendar day.'
    );
  }

  const rawRows = parseWorkLogFile(filePath);
  if (!rawRows.length) {
    throw badRequestError('The uploaded file contains no data rows.');
  }

  // Phase 0 — structural validation, every row.
  const shapeErrors = [];
  const shapedRows = [];
  for (const raw of rawRows) {
    const { errors, data } = validateRowShape(raw);
    if (errors.length) shapeErrors.push({ row: raw._rowNum, errors });
    else shapedRows.push({ row: raw._rowNum, ...data });
  }
  if (shapeErrors.length) {
    throw validationError('The uploaded file has formatting errors.', { phase: 'format', error_rows: shapeErrors });
  }

  // Gate 1 — ownership (PRIMARY Manager only — see this section's header doc).
  const isAdminTier = Number.isInteger(hierarchyRank) && hierarchyRank <= ADMIN_TIER_MAX_RANK;
  const isBuAdmin = hierarchyRank === BU_ADMIN_RANK;

  // Manager tier: resolve the caller's ENTIRE set of PRIMARY-mapped
  // Employees up front, in one batched lookup with NO Business Unit scope
  // at all — employee_code is unique only per (company_id, employee_code)
  // (see Employee.js's uq_employees_company_code index), so an unscoped
  // code search could ambiguously match the wrong company's employee, and
  // a company/BU-scoped search (employeeRepository.findByCode(code,
  // companyId), using the MANAGER's own active BU) would silently miss any
  // mapped Employee sitting in a different Business Unit — exactly the bug
  // already fixed in managerSelfServiceService.getMyEmployees. Matching
  // codes against this pre-authorized, mapping-derived set sidesteps both
  // problems: presence in the map already proves both "exists" and "you
  // are their PRIMARY Manager," so no per-row DB round trip is needed
  // either.
  let primaryEmployeeByCode = null;
  if (!isAdminTier && !isBuAdmin) {
    const primaryMappings = (await managerEmployeeMappingRepository.findByManager(managerUserId))
      .filter((mapping) => mapping.mapping_type === 'PRIMARY');
    const mappedEmployeeIds = primaryMappings.map((mapping) => mapping.employee_id);
    const mappedEmployees = mappedEmployeeIds.length
      ? await Employee.findAll({
        where: { id: { [Op.in]: mappedEmployeeIds } },
        attributes: ['id', 'employee_code', 'status', 'is_deleted'],
      })
      : [];
    primaryEmployeeByCode = new Map(
      mappedEmployees
        .filter((employee) => employee.status === 'active' && !employee.is_deleted)
        .map((employee) => [employee.employee_code.trim().toUpperCase(), employee])
    );
  }

  const gate1Errors = [];
  const rowsWithEmployee = [];

  for (const row of shapedRows) {
    let employee;
    let isOwnedByCaller;

    if (isAdminTier) {
      employee = await employeeRepository.findByCode(row.employee_code, companyId);
      isOwnedByCaller = !!employee;
    } else if (isBuAdmin) {
      employee = await employeeRepository.findByCode(row.employee_code, companyId);
      if (employee) {
        const scopeIds = callerBuIds.length > 0 ? callerBuIds : [companyId].filter(Boolean);
        const scoped = await employeeRepository.findById(employee.id, scopeIds.length === 1 ? scopeIds[0] : scopeIds);
        isOwnedByCaller = !!scoped;
      } else {
        isOwnedByCaller = false;
      }
    } else {
      employee = primaryEmployeeByCode.get(row.employee_code);
      isOwnedByCaller = !!employee;
    }

    // The Manager-tier map above is already pre-filtered to active,
    // non-deleted Employees, so this status/is_deleted re-check only
    // matters for the Admin/BU Admin branches, whose findByCode() lookup
    // doesn't filter on either.
    if (!employee || ((isAdminTier || isBuAdmin) && (employee.status !== 'active' || employee.is_deleted))) {
      gate1Errors.push({ row: row.row, errors: [`Employee Code "${row.employee_code}" was not found or is not active.`] });
      continue;
    }

    if (!isOwnedByCaller) {
      gate1Errors.push({
        row: row.row,
        errors: [`You are not the Primary Manager of "${row.employee_name}" (${row.employee_code}).`],
      });
      continue;
    }

    rowsWithEmployee.push({ ...row, employee_id: employee.id });
  }

  if (gate1Errors.length) {
    throw validationError('Some employees in the file could not be validated.', { phase: 'ownership', error_rows: gate1Errors });
  }

  // Gate 2 — Service PO must be one of that Employee's actively-mapped
  // Service POs (Main PO only). loadMappedPOsWithHierarchy is already
  // scoped to the Employee's own active employee_servicepo_mapping rows,
  // so a name not found in it covers BOTH "no such Service PO" and "not
  // mapped to this Employee" in one lookup.
  const mappedPOsByEmployeeId = new Map();
  const gate2Errors = [];
  const resolvedRows = [];

  for (const row of rowsWithEmployee) {
    let nameMap = mappedPOsByEmployeeId.get(row.employee_id);
    if (!nameMap) {
      const { mappedPOs } = await employeeTimesheetService.loadMappedPOsWithHierarchy(row.employee_id, companyId);
      nameMap = new Map(mappedPOs.map((po) => [po.service_po_name.trim().toLowerCase(), po.id]));
      mappedPOsByEmployeeId.set(row.employee_id, nameMap);
    }

    const servicePOId = nameMap.get(row.service_po_name.trim().toLowerCase());
    if (!servicePOId) {
      gate2Errors.push({
        row: row.row,
        errors: [`Service PO "${row.service_po_name}" is not mapped to employee "${row.employee_code}".`],
      });
      continue;
    }

    resolvedRows.push({ ...row, service_po_id: servicePOId });
  }

  if (gate2Errors.length) {
    throw validationError('Some Service POs in the file could not be validated.', { phase: 'service_po', error_rows: gate2Errors });
  }

  // Both gates passed for every row — group by Employee and REPLACE-SAVE
  // each Employee's Monthly Work Log via the shared, already-tested engine.
  const rowsByEmployeeId = new Map();
  for (const row of resolvedRows) {
    if (!rowsByEmployeeId.has(row.employee_id)) rowsByEmployeeId.set(row.employee_id, []);
    rowsByEmployeeId.get(row.employee_id).push(row);
  }

  const results = [];
  for (const [employeeId, rows] of rowsByEmployeeId) {
    const entries = rows.map((r) => ({ service_po_id: r.service_po_id, hours: r.hours, description: r.description }));
    await employeeMonthlyWorkLogService.submitMonthlyWorkLog(employeeId, companyId, { month, year, entries }, {
      creatorId: actorId,
      forceApproved: true,
      allowHierarchyNode: false,
    });
    results.push({ employee_id: employeeId, employee_code: rows[0].employee_code, entry_count: entries.length });
  }

  await createAuditLog(
    actorId,
    'CREATE',
    'employee_work_logs',
    null,
    null,
    { bulk_upload: true, month, year, employees: results.length, total_rows: resolvedRows.length },
    ipAddress
  );

  logger.info('Manager bulk-uploaded Monthly Work Log', {
    managerUserId, month, year, employees: results.length, totalRows: resolvedRows.length, actorId,
  });

  return {
    month,
    year,
    employees_processed: results.length,
    total_rows: resolvedRows.length,
    results,
  };
};

module.exports = {
  getMonthlyWorkLogForEmployee,
  submitMonthlyWorkLogForEmployee,
  deleteMonthlyWorkLogForEmployee,
  bulkUploadMonthlyWorkLog,
};
