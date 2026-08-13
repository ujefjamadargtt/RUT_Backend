'use strict';

const xlsx = require('xlsx');
const { sequelize, Role } = require('../models');
const employeeRepository = require('../repositories/employeeRepository');
const userRepository = require('../repositories/userRepository');
const logger = require('../utils/logger');

// Bulk-imported logins all get this same default password rather than a
// per-row random one (HR request — random passwords aren't practical to
// hand out across a whole spreadsheet of new hires at once). Employees can
// change it via the existing forgot-password flow after first login.
const DEFAULT_IMPORT_PASSWORD = 'Gtt@1234';

// Flexible column-header → field mapping (matched after normalising to lowercase + collapsed spaces)
const HEADER_MAP = {
  'employee code': 'employee_code',
  'emp code': 'employee_code',
  'empcode': 'employee_code',
  'code': 'employee_code',
  'emp_code': 'employee_code',
  'full name': 'full_name',
  'name': 'full_name',
  'employee name': 'full_name',
  'fullname': 'full_name',
  'full_name': 'full_name',
  'designation': 'designation',
  'role': 'designation',
  'job title': 'designation',
  'total experience': 'total_experience',
  'total exp': 'total_experience',
  'total_experience': 'total_experience',
  'total_exp': 'total_experience',
  'experience': 'total_experience',
  'company experience': 'company_experience',
  'company exp': 'company_experience',
  'company_experience': 'company_experience',
  'company_exp': 'company_experience',
  'description': 'resource_description',
  'resource description': 'resource_description',
  'resource_description': 'resource_description',
  'date of joining': 'date_of_joining',
  'joining date': 'date_of_joining',
  'doj': 'date_of_joining',
  'date_of_joining': 'date_of_joining',
  'date of leaving': 'date_of_leaving',
  'leaving date': 'date_of_leaving',
  'dol': 'date_of_leaving',
  'date_of_leaving': 'date_of_leaving',
  'status': 'status',
  'email': 'email',
  'email id': 'email',
  'emailid': 'email',
  'email address': 'email',
};

const CODE_RE = /^[A-Z0-9_/#-]{2,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Employee is pure business data (see database/migrations/
// 20260842_employees_drop_login_columns.sql); a row only gets a linked
// User/login account when an "Email ID" column is present and populated —
// same convention as employeeService.create(), minus Manager assignment,
// which this file's format doesn't have columns for. HR can assign a
// Manager afterwards via PUT /employees/:id. Rows with no email import as
// business-data-only, same as before.

function normaliseHeader(raw) {
  return String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Convert Excel date serial number → YYYY-MM-DD
function excelSerialToISO(serial) {
  const utcMs = (serial - 25569) * 86400 * 1000;
  const d = new Date(utcMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function parseDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return excelSerialToISO(value);
  if (value instanceof Date) {
    const yyyy = value.getUTCFullYear();
    const mm = String(value.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(value.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  const str = String(value).trim();
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const dmy = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  return null;
}

function parseNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = parseFloat(String(value));
  return isNaN(n) ? null : n;
}

function isBlank(v) {
  return v === null || v === undefined || v === '';
}

/**
 * Parse the first sheet of the uploaded Excel/CSV file.
 * Returns an array of raw row objects keyed by canonical field names.
 */
function parseEmployeeFile(filePath) {
  const workbook = xlsx.readFile(filePath, { cellDates: false, raw: false });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const raw = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });

  if (!raw.length) return [];

  // Detect header row: first row with at least 2 recognised columns in first 5 rows
  let headerRowIdx = -1;
  let mappedHeaders = [];

  for (let i = 0; i < Math.min(5, raw.length); i++) {
    const mapped = raw[i].map((h) => HEADER_MAP[normaliseHeader(h)] || null);
    if (mapped.filter(Boolean).length >= 2) {
      headerRowIdx = i;
      mappedHeaders = mapped;
      break;
    }
  }

  if (headerRowIdx === -1) {
    const err = new Error(
      'Could not detect a valid header row. ' +
      'Expected columns like "Employee Code", "Full Name", "Designation", etc.'
    );
    err.statusCode = 422;
    throw err;
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

    if (!hasData) continue; // skip entirely blank rows
    rows.push(row);
  }

  return rows;
}

/**
 * Validate a single raw row.
 * Returns { errors: string[], data: object }.
 * data is only populated when errors is empty.
 */
function validateRow(raw, existingCodes, seenCodes, existingEmails, seenEmails) {
  const errors = [];
  const data = {};

  // ── employee_code (required) ────────────────────────────────────────────────
  const code = String(raw.employee_code || '').trim().toUpperCase();
  if (!code) {
    errors.push('Employee code is required.');
  } else if (!CODE_RE.test(code)) {
    errors.push('Employee code must be 2–20 uppercase alphanumeric characters (- / # _ allowed).');
  } else if (existingCodes.has(code)) {
    errors.push(`Employee code "${code}" already exists.`);
  } else if (seenCodes.has(code)) {
    errors.push(`Employee code "${code}" is duplicated within this file.`);
  } else {
    data.employee_code = code;
  }

  // ── full_name (required) ────────────────────────────────────────────────────
  const name = String(raw.full_name || '').trim();
  if (!name) {
    errors.push('Full name is required.');
  } else if (name.length < 2 || name.length > 100) {
    errors.push('Full name must be 2–100 characters.');
  } else {
    data.full_name = name;
  }

  // ── email (optional — populating it creates a linked login account) ────────
  if (!isBlank(raw.email)) {
    const email = String(raw.email).trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 100) {
      errors.push('Email must be a valid email address (max 100 characters).');
    } else if (existingEmails.has(email)) {
      errors.push(`Email "${email}" is already registered.`);
    } else if (seenEmails.has(email)) {
      errors.push(`Email "${email}" is duplicated within this file.`);
    } else {
      data.email = email;
    }
  }

  // ── designation (optional) ──────────────────────────────────────────────────
  if (!isBlank(raw.designation)) {
    const desig = String(raw.designation).trim();
    if (desig.length > 100) errors.push('Designation cannot exceed 100 characters.');
    else if (desig) data.designation = desig;
  }

  // ── total_experience (optional) ─────────────────────────────────────────────
  if (!isBlank(raw.total_experience)) {
    const totalExp = parseNumber(raw.total_experience);
    if (totalExp === null || totalExp < 0 || totalExp > 60) {
      errors.push('Total experience must be a number between 0 and 60.');
    } else {
      data.total_experience = totalExp;
    }
  }

  // ── company_experience (optional) ───────────────────────────────────────────
  if (!isBlank(raw.company_experience)) {
    const compExp = parseNumber(raw.company_experience);
    if (compExp === null || compExp < 0 || compExp > 60) {
      errors.push('Company experience must be a number between 0 and 60.');
    } else if (data.total_experience !== undefined && compExp > data.total_experience) {
      errors.push('Company experience cannot exceed total experience.');
    } else {
      data.company_experience = compExp;
    }
  }

  // ── resource_description (optional) ─────────────────────────────────────────
  if (!isBlank(raw.resource_description)) {
    const desc = String(raw.resource_description).trim();
    if (desc.length > 2000) errors.push('Resource description cannot exceed 2000 characters.');
    else if (desc) data.resource_description = desc;
  }

  // ── date_of_joining (optional) ──────────────────────────────────────────────
  if (!isBlank(raw.date_of_joining)) {
    const doj = parseDate(raw.date_of_joining);
    if (!doj) {
      errors.push('Date of joining must be a valid date (YYYY-MM-DD or DD/MM/YYYY).');
    } else {
      data.date_of_joining = doj;
    }
  }

  // ── date_of_leaving (optional) ──────────────────────────────────────────────
  if (!isBlank(raw.date_of_leaving)) {
    const dol = parseDate(raw.date_of_leaving);
    if (!dol) {
      errors.push('Date of leaving must be a valid date (YYYY-MM-DD or DD/MM/YYYY).');
    } else if (data.date_of_joining && dol <= data.date_of_joining) {
      errors.push('Date of leaving must be after date of joining.');
    } else {
      data.date_of_leaving = dol;
    }
  }

  // ── status (optional, default 'active') ─────────────────────────────────────
  if (!isBlank(raw.status)) {
    const status = String(raw.status).trim().toLowerCase();
    if (!['active', 'inactive'].includes(status)) {
      errors.push('Status must be "active" or "inactive".');
    } else {
      data.status = status;
    }
  } else {
    data.status = 'active';
  }

  return { errors, data };
}

/**
 * Parse, validate, and import employees from the uploaded file.
 *
 * @param {string} filePath - Absolute path to the saved upload file
 * @param {number} userId   - ID of the authenticated user performing the import
 * @param {number} companyId
 * @returns {Promise<{ total, imported, skipped, error_rows, credentials }>}
 */
async function importEmployees(filePath, userId, companyId) {
  // 1. Parse Excel / CSV
  const rawRows = parseEmployeeFile(filePath);

  if (!rawRows.length) {
    const err = new Error('The uploaded file contains no data rows.');
    err.statusCode = 422;
    throw err;
  }

  // 2. Batch-fetch existing codes (scoped to this company — per-company
  // uniqueness) and existing emails (global — see users_email_key) to avoid
  // N+1 queries.
  const existingForCompany = await employeeRepository.findAllForImport(companyId);
  const existingCodes = new Set(existingForCompany.map((e) => e.employee_code.toUpperCase()));
  const existingEmails = new Set(await userRepository.findAllEmails());

  // 3. Validate all rows; track codes/emails seen within this file to catch duplicates
  const seenCodes = new Set();
  const seenEmails = new Set();
  const validRows = [];
  const errorRows = [];

  for (const raw of rawRows) {
    const { errors, data } = validateRow(raw, existingCodes, seenCodes, existingEmails, seenEmails);
    if (errors.length) {
      errorRows.push({ row: raw._rowNum, errors });
    } else {
      validRows.push(data);
      seenCodes.add(data.employee_code);
      if (data.email) seenEmails.add(data.email);
    }
  }

  // 4. Look up the "Employee" role once, only if at least one row needs a
  // linked login account (same role every auto-created User gets — see
  // employeeService.create()).
  let employeeRole = null;
  if (validRows.some((row) => row.email)) {
    employeeRole = await Role.findOne({ where: { role_name: 'Employee' } });
    if (!employeeRole) {
      const err = new Error('The "Employee" role is not seeded.');
      err.statusCode = 500;
      throw err;
    }
  }

  // 5. Insert valid rows — Employee always; a linked User too (role =
  // Employee, temporary password) when the row carried an email, both in
  // one transaction so a failed User insert doesn't leave an orphan Employee.
  let importedCount = 0;
  const dbErrors = [];
  const credentials = [];

  for (const row of validRows) {
    const { email, ...employeeFields } = row;
    try {
      await sequelize.transaction(async (transaction) => {
        const employee = await employeeRepository.create({
          ...employeeFields,
          company_id: companyId,
          created_by: userId,
          updated_by: userId,
        }, { transaction });

        if (email) {
          await userRepository.create({
            email,
            password: DEFAULT_IMPORT_PASSWORD,
            role_id: employeeRole.id,
            employee_id: employee.id,
            company_id: companyId,
            status: 'active',
            created_by: userId,
            updated_by: userId,
          }, { transaction });
          credentials.push({ employee_code: employee.employee_code, email, temporaryPassword: DEFAULT_IMPORT_PASSWORD });
        }
      });
      importedCount++;
    } catch (dbErr) {
      logger.error('Employee import DB error', { code: row.employee_code, error: dbErr.message });
      dbErrors.push({ row: null, errors: [`DB error for "${row.employee_code}": ${dbErr.message}`] });
    }
  }

  logger.info('Employee import completed', {
    userId,
    total: rawRows.length,
    imported: importedCount,
    skipped: errorRows.length,
    db_errors: dbErrors.length,
    logins_created: credentials.length,
  });

  return {
    total: rawRows.length,
    imported: importedCount,
    skipped: errorRows.length + dbErrors.length,
    error_rows: [...errorRows, ...dbErrors],
    credentials,
  };
}

module.exports = { importEmployees };
