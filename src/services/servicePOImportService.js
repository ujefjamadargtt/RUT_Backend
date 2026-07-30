'use strict';

const xlsx = require('xlsx');
const { Client, ServiceType, ServiceCategory, ServicePO } = require('../models');
const servicePORepository = require('../repositories/servicePORepository');
const { generatePOCode } = require('../helpers/codeGenerator');
const { createServicePOSchema } = require('../validations/servicePOValidation');
const logger = require('../utils/logger');

// Flexible column-header → field mapping (matched after normalising to lowercase + collapsed spaces)
// NOTE: Service PO Code is intentionally NOT mapped here — it is always auto-generated
// during import (format PO-YYYYMMDD-XXXX, via generatePOCode()), even if the sheet has a
// PO Code column. Any such column is ignored.
const HEADER_MAP = {
  'service po name': 'service_po_name',
  'po name': 'service_po_name',
  'name': 'service_po_name',
  'service_po_name': 'service_po_name',

  'client code': 'client_code',
  'client_code': 'client_code',
  'clt code': 'client_code',

  'client name': 'client_name',
  'client': 'client_name',
  'customer': 'client_name',
  'client_name': 'client_name',

  'service type': 'service_type_name',
  'service type name': 'service_type_name',
  'servicetype': 'service_type_name',
  'service_type_name': 'service_type_name',
  'service_type': 'service_type_name',

  'po value': 'po_value',
  'value': 'po_value',
  'po_value': 'po_value',

  'start date': 'start_date',
  'start_date': 'start_date',

  'end date': 'end_date',
  'end_date': 'end_date',

  'expected man hours': 'expected_man_hours',
  'expected hours': 'expected_man_hours',
  'man hours': 'expected_man_hours',
  'expected_man_hours': 'expected_man_hours',

  // NOTE: Is Billable is intentionally NOT mapped here — it is always derived
  // from the selected Service Type's category (see validateRow()), never read
  // from the sheet, so any such column is ignored.

  'account manager': 'account_manager',
  'account_manager': 'account_manager',

  'service description': 'service_description',
  'description': 'service_description',
  'service_description': 'service_description',

  'invoice frequency': 'invoice_frequency',
  'invoice_frequency': 'invoice_frequency',

  'invoice amount': 'invoice_amount',
  'invoice_amount': 'invoice_amount',

  'status': 'status',
};

// client_id / service_type_id are resolved by DB lookup (with their own not-found/inactive
// messages) before this schema runs, so they are relaxed to optional here — Joi is only
// responsible for format/range/enum/required rules on the remaining fields, reusing the
// exact same rules the single-record create API enforces.
const rowSchema = createServicePOSchema.fork(['client_id', 'service_type_id'], (s) => s.optional());

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

// Rejects syntactically-shaped but calendar-invalid dates (e.g. month 13, Feb 30)
// so callers get a clean "not a valid date" error instead of it silently reaching
// downstream validation as a bogus ISO string.
function isValidISODate(iso) {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
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
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return isValidISODate(str) ? str : null;
  const dmy = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) {
    const iso = `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
    return isValidISODate(iso) ? iso : null;
  }
  return null;
}

/**
 * Parse a numeric cell that may carry currency symbols and/or thousands
 * separators (e.g. "₹5,00,000.00", "$1,234.56", "500,000") — common when a
 * finance-authored sheet formats the PO Value / Invoice Amount column as
 * currency. Strips everything except digits, the decimal point, and a
 * leading minus sign before parsing.
 */
function parseNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return isNaN(value) ? null : value;
  const cleaned = String(value).trim().replace(/[^0-9.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function isBlank(v) {
  return v === null || v === undefined || v === '';
}

/**
 * Parse the first sheet of the uploaded Excel/CSV file.
 * Returns an array of raw row objects keyed by canonical field names.
 */
function parseServicePOFile(filePath) {
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
      'Expected columns like "Service PO Name", "Client Code"/"Client Name", "Service Type", "Start Date", "End Date", etc.'
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
 * Build the row_data snapshot returned alongside error messages, so a failed
 * row can be located and corrected in the source sheet without guesswork.
 */
function buildRowData(raw) {
  const { _rowNum, ...fields } = raw;
  return fields;
}

/**
 * Validate a single raw row.
 * - Resolves Client (by code or name) and Service Type (by name) against the DB.
 * - Derives is_billable from the resolved Service Type's category via
 *   service_categories.report_bucket_key (= 'billable' → true, anything else
 *   → false) — never from the sheet, never from a hardcoded category name,
 *   and never from the schema default.
 * - Normalises messy Excel cell values (currency-formatted numbers, Excel serial
 *   dates, DD/MM/YYYY dates) into clean typed values.
 * - Delegates all required/length/range/enum/pattern rules to the same Joi
 *   schema the single-record create API uses, so import and manual-create can
 *   never silently drift apart.
 *
 * @returns {{ errors: string[], data: object }} data is only populated when errors is empty.
 */
function validateRow(raw, ctx) {
  const errors = [];
  const candidate = {};
  // Fields our own parsing already flagged as invalid — Joi's messages for these
  // (e.g. "X is required" for a field we deliberately left unset, or a ref-based
  // cross-field error caused by an already-reported bad date) would just be
  // confusing duplicates, so they're filtered out below.
  const invalidFields = new Set();

  // ── client (required) — resolved by Client Code or Client Name ─────────────
  const clientCodeRaw = String(raw.client_code || '').trim();
  const clientNameRaw = String(raw.client_name || '').trim();
  if (!clientCodeRaw && !clientNameRaw) {
    errors.push('Client Code or Client Name is required.');
  } else {
    const client = clientCodeRaw
      ? ctx.clientByCode.get(clientCodeRaw.toLowerCase())
      : ctx.clientByName.get(clientNameRaw.toLowerCase());
    if (!client) {
      errors.push(`Client "${clientCodeRaw || clientNameRaw}" not found.`);
    } else if (client.status !== 'active') {
      errors.push(`Client "${client.client_name}" is inactive.`);
    } else {
      candidate.client_id = client.id;
    }
  }

  // ── service_type_name (required) ────────────────────────────────────────────
  const serviceTypeName = String(raw.service_type_name || '').trim();
  if (!serviceTypeName) {
    errors.push('Service Type is required.');
  } else {
    const serviceType = ctx.serviceTypeByName.get(serviceTypeName.toLowerCase());
    if (!serviceType) {
      errors.push(`Service Type "${serviceTypeName}" not found.`);
    } else {
      candidate.service_type_id = serviceType.id;
      // is_billable is always derived from the Service Type's category —
      // never taken from the sheet and never left to the schema's default.
      candidate.is_billable = serviceType.is_billable;
    }
  }

  // ── service_po_name ──────────────────────────────────────────────────────────
  if (!isBlank(raw.service_po_name)) {
    candidate.service_po_name = String(raw.service_po_name).trim();
  }

  // ── po_value (required for import, even though optional on the single-create API) ──
  if (isBlank(raw.po_value)) {
    errors.push('PO value is required.');
  } else {
    const poValue = parseNumber(raw.po_value);
    if (poValue === null) {
      errors.push(`PO value "${raw.po_value}" is not a valid number.`);
      invalidFields.add('po_value');
    } else {
      candidate.po_value = poValue;
    }
  }

  // ── start_date / end_date ────────────────────────────────────────────────────
  if (!isBlank(raw.start_date)) {
    const startDate = parseDate(raw.start_date);
    if (!startDate) {
      errors.push(`Start date "${raw.start_date}" is not a valid date (expected YYYY-MM-DD or DD/MM/YYYY).`);
      // An invalid start_date also makes end_date's "must be after start_date"
      // ref-check meaningless — suppress its confusing Joi message too.
      invalidFields.add('start_date');
      invalidFields.add('end_date');
    } else {
      candidate.start_date = startDate;
    }
  }

  if (!isBlank(raw.end_date)) {
    const endDate = parseDate(raw.end_date);
    if (!endDate) {
      errors.push(`End date "${raw.end_date}" is not a valid date (expected YYYY-MM-DD or DD/MM/YYYY).`);
      invalidFields.add('end_date');
    } else {
      candidate.end_date = endDate;
    }
  }

  // ── expected_man_hours ───────────────────────────────────────────────────────
  if (!isBlank(raw.expected_man_hours)) {
    const hours = parseNumber(raw.expected_man_hours);
    if (hours === null) {
      errors.push(`Expected man hours "${raw.expected_man_hours}" is not a valid number.`);
      invalidFields.add('expected_man_hours');
    } else {
      candidate.expected_man_hours = hours;
    }
  }

  // ── free-text / enum fields (Joi validates length, enum membership) ─────────
  if (!isBlank(raw.account_manager)) candidate.account_manager = String(raw.account_manager).trim();
  if (!isBlank(raw.service_description)) candidate.service_description = String(raw.service_description).trim();
  if (!isBlank(raw.invoice_frequency)) candidate.invoice_frequency = String(raw.invoice_frequency).trim().toLowerCase();
  if (!isBlank(raw.invoice_amount)) {
    const amt = parseNumber(raw.invoice_amount);
    if (amt === null) {
      errors.push(`Invoice amount "${raw.invoice_amount}" is not a valid number.`);
      invalidFields.add('invoice_amount');
    } else {
      candidate.invoice_amount = amt;
    }
  }
  if (!isBlank(raw.status)) candidate.status = String(raw.status).trim().toLowerCase();

  // ── delegate required/length/range/enum/pattern rules to the shared schema ──
  const { error, value } = rowSchema.validate(candidate, { abortEarly: false, stripUnknown: true });
  if (error) {
    errors.push(...error.details.filter((d) => !invalidFields.has(d.path[0])).map((d) => d.message));
  }

  return { errors, data: error ? {} : value };
}

/**
 * Parse, validate, and import Service POs from the uploaded file.
 *
 * Validation-first, all-or-nothing: every row is validated before anything is
 * written to the database. If even one row fails validation, the import is
 * aborted immediately and NOTHING is inserted — only once every row passes
 * does the insert step run, mirroring employeeImportService.js /
 * clientImportService.js's parse → validate → insert structure and response
 * shape ({ total, imported, skipped, error_rows }).
 *
 * @param {string} filePath - Absolute path to the saved upload file
 * @param {number} userId   - ID of the authenticated user performing the import
 * @param {number} companyId
 * @returns {Promise<{ total, imported, skipped, error_rows }>}
 */
async function importServicePOs(filePath, userId, companyId) {
  // 1. Parse Excel / CSV
  const rawRows = parseServicePOFile(filePath);

  if (!rawRows.length) {
    const err = new Error('The uploaded file contains no data rows.');
    err.statusCode = 422;
    throw err;
  }

  // 2. Batch-fetch reference data to avoid N+1 queries — scoped to this
  // company, so a code/name that only exists in another company never
  // resolves here (matches uq_service_pos_company_code's per-company scope).
  const [existingPOs, clients, serviceTypes] = await Promise.all([
    ServicePO.findAll({ where: { company_id: companyId }, attributes: ['service_po_code'], raw: true }),
    Client.findAll({ where: { company_id: companyId }, attributes: ['id', 'client_code', 'client_name', 'status'], raw: true }),
    ServiceType.findAll({
      where: { is_deleted: false, company_id: companyId },
      attributes: ['id', 'service_type_name'],
      include: [{ model: ServiceCategory, as: 'serviceCategory', attributes: ['id', 'name', 'report_bucket_key'] }],
    }),
  ]);

  const existingCodes = new Set(existingPOs.map((p) => p.service_po_code.toUpperCase()));
  const clientByCode = new Map(clients.map((c) => [c.client_code.toLowerCase(), c]));
  const clientByName = new Map(clients.map((c) => [c.client_name.toLowerCase(), c]));
  // is_billable is derived here (the resolved Service Type's category has
  // report_bucket_key = 'billable' → true, anything else → false) so
  // validateRow() never has to touch the DB or fall back to the schema default.
  const serviceTypeByName = new Map(
    serviceTypes.map((s) => [
      s.service_type_name.toLowerCase(),
      {
        id: s.id,
        service_type_name: s.service_type_name,
        is_billable: s.serviceCategory?.report_bucket_key === 'billable',
      },
    ])
  );

  // 3. Validate every row up front. No database write happens until this loop
  //    finishes and every single row has passed.
  const seenCodes = new Set();
  const validRows = [];
  const errorRows = [];

  for (const raw of rawRows) {
    const { errors, data } = validateRow(raw, { clientByCode, clientByName, serviceTypeByName });
    if (errors.length) {
      errorRows.push({ row_number: raw._rowNum, row_data: buildRowData(raw), errors });
      continue;
    }
    validRows.push({ ...data, _rowNum: raw._rowNum, _rowData: buildRowData(raw) });
  }

  // 3a. Validation gate — if any row failed, stop here. Insert never runs.
  if (errorRows.length > 0) {
    logger.info('Service PO import aborted — validation errors found, nothing inserted', {
      userId,
      total: rawRows.length,
      skipped: errorRows.length,
    });

    return {
      total: rawRows.length,
      imported: 0,
      skipped: errorRows.length,
      error_rows: errorRows,
    };
  }

  // 4. Every row passed validation — auto-generate a unique PO code for each
  //    (never taken from the sheet) before inserting.
  for (const row of validRows) {
    let code = generatePOCode();
    let attempts = 0;
    while (existingCodes.has(code) || seenCodes.has(code)) {
      if (attempts >= 5) {
        code = null;
        break;
      }
      code = generatePOCode();
      attempts++;
    }

    if (!code) {
      row._skip = true;
      errorRows.push({
        row_number: row._rowNum,
        row_data: row._rowData,
        errors: [`Failed to generate a unique Service PO code for "${row.service_po_name}".`],
      });
      continue;
    }

    row.service_po_code = code;
    seenCodes.add(code);
  }

  // 5. Insert valid rows
  let importedCount = 0;

  for (const row of validRows) {
    if (row._skip) continue;
    const { _rowNum, _rowData, _skip, ...payload } = row;
    try {
      await servicePORepository.create({ ...payload, company_id: companyId, created_by: userId, updated_by: userId });
      importedCount++;
    } catch (dbErr) {
      logger.error('Service PO import DB error', { code: row.service_po_code, error: dbErr.message });
      errorRows.push({
        row_number: _rowNum,
        row_data: _rowData,
        errors: [`Database error while saving this row: ${dbErr.message}`],
      });
    }
  }

  logger.info('Service PO import completed', {
    userId,
    total: rawRows.length,
    imported: importedCount,
    skipped: errorRows.length,
  });

  return {
    total: rawRows.length,
    imported: importedCount,
    skipped: errorRows.length,
    error_rows: errorRows,
  };
}

module.exports = { importServicePOs };
