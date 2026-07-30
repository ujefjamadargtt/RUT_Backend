'use strict';

const path = require('path');
const fs = require('fs');
const xlsx = require('xlsx');
const { Readable } = require('stream');
const { Op } = require('sequelize');
const { Employee, ServicePO, ServiceType, SubProject, sequelize } = require('../models');
const timesheetRepository = require('../repositories/timesheetRepository');
const timesheetImportRepository = require('../repositories/timesheetImportRepository');
const { createAuditLog } = require('../middlewares/auditLog');
const logger = require('../utils/logger');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const dateHelper = require('../helpers/dateHelper');

// ── Expected spreadsheet column headers (case-insensitive, trimmed) ───────────
const HEADER_MAP = {
  'resource name':    'resourceName',
  'employee':         'resourceName',
  'employee name':    'resourceName',
  'emp name':         'resourceName',
  'employee code':    'resourceName',
  'emp code':         'resourceName',
  'emp id':           'resourceName',
  'name':             'resourceName',
  'service po name':  'servicePOName',
  'po name':          'servicePOName',
  'service po':       'servicePOName',
  'sub project':      'subProject',
  'sub-project':      'subProject',
  'subproject':       'subProject',
  'date':             'date',
  'timesheet date':   'date',
  'hours':            'hours',
  'hours logged':     'hours',
  'logged hours':     'hours',
};

/**
 * Normalise a raw header string to a canonical field key.
 * @param {string} header
 * @returns {string|null}
 */
function normaliseHeader(header) {
  if (!header) return null;
  const key = String(header).trim().toLowerCase();
  return HEADER_MAP[key] || null;
}

/**
 * Parse a date value that may arrive as:
 *  - JavaScript Date object (xlsx returns these for date-formatted cells)
 *  - Excel serial number (numeric)
 *  - ISO / locale date string
 *
 * Returns a YYYY-MM-DD string or null.
 * @param {*} raw
 * @returns {string|null}
 */
function parseDate(raw) {
  if (!raw) return null;

  // xlsx can return a JS Date
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return null;
    return dateHelper.formatDate(raw);
  }

  // Excel serial number
  if (typeof raw === 'number') {
    const jsDate = xlsx.SSF.parse_date_code(raw);
    if (!jsDate) return null;
    const y = jsDate.y;
    const m = String(jsDate.m).padStart(2, '0');
    const d = String(jsDate.d).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // String attempt — try to detect common formats
  const str = String(raw).trim();
  if (!str) return null;

  // ISO: 2025-07-15
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;

  // DD/MM/YYYY or DD-MM-YYYY
  const dmy = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  // MM/DD/YYYY
  const mdy = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    const [, m, d, y] = mdy;
    if (parseInt(m, 10) <= 12) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  // Last resort: let Date constructor try
  const attempt = new Date(str);
  if (!isNaN(attempt.getTime())) {
    return dateHelper.formatDate(attempt);
  }

  return null;
}

// Rounding rule: if minutes > 20 → round up to next whole hour, else floor.
// e.g. 73:21:00 → 74, 73:20:00 → 73, 73:00:00 → 73, 73:41:00 → 74
function roundHours(hours, minutes) {
  return minutes > 20 ? hours + 1 : hours;
}

function parseHours(raw) {
  if (raw === undefined || raw === null) return null;

  // Excel often represents times as numeric day-fractions (e.g. 0.5 = 12 hours).
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const decimal = raw * 24;
    const h = Math.floor(decimal);
    const m = (decimal - h) * 60;
    return roundHours(h, m);
  }

  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return null;
    // Use local time components — Excel / xlsx returns JS Date objects
    // that reflect the spreadsheet cell in local time.
    const hours = raw.getHours();
    const minutes = raw.getMinutes();
    return roundHours(hours, minutes);
  }

  const value = String(raw).trim();
  if (value === '') return null;

  const trimmed = value.replace(/,/g, '.');

  // Duration format HH:MM or HH:MM:SS
  const durationMatch = trimmed.match(/^([0-9]+):([0-5]?[0-9])(?::([0-5]?[0-9]))?$/);
  if (durationMatch) {
    const hours = parseInt(durationMatch[1], 10);
    const minutes = parseInt(durationMatch[2], 10);
    if (Number.isFinite(hours) && Number.isFinite(minutes)) {
      return roundHours(hours, minutes);
    }
    return null;
  }

  // Excel time values can appear as ISO datetime strings.
  const isoTime = new Date(trimmed);
  if (!isNaN(isoTime.getTime())) {
    const yearUtc = isoTime.getUTCFullYear();
    if (yearUtc && yearUtc <= 1900) {
      const excelBaseUtc = Date.UTC(1899, 11, 30, 0, 0, 0);
      const hoursDiff = (isoTime.getTime() - excelBaseUtc) / (1000 * 60 * 60);
      if (Number.isFinite(hoursDiff)) {
        const h = Math.floor(hoursDiff);
        const m = (hoursDiff - h) * 60;
        return roundHours(h, m);
      }
    }

    const hours = isoTime.getHours();
    const minutes = isoTime.getMinutes();
    if (hours || minutes) {
      return roundHours(hours, minutes);
    }
  }

  const parsed = parseFloat(trimmed);
  if (Number.isFinite(parsed)) {
    const h = Math.floor(parsed);
    const m = (parsed - h) * 60;
    return roundHours(h, m);
  }

  return null;
}

function findHeaderRow(rawRows) {
  const fieldCandidates = ['resourceName', 'servicePOName', 'date', 'hours'];
  const maxHeaderSearch = Math.min(rawRows.length, 5);

  for (let rowIndex = 0; rowIndex < maxHeaderSearch; rowIndex += 1) {
    const row = rawRows[rowIndex];
    if (!Array.isArray(row)) continue;

    const fieldIndex = {};
    row.forEach((cell, idx) => {
      const fieldName = normaliseHeader(cell);
      if (fieldName && !(fieldName in fieldIndex)) {
        fieldIndex[fieldName] = idx;
      }
    });

    const hasResourceName = 'resourceName' in fieldIndex;
    const hasFullHeaders = fieldCandidates.every((f) => f in fieldIndex);

    if (hasResourceName && (hasFullHeaders || row.some((cell, idx) => idx !== fieldIndex.resourceName && String(cell || '').trim() !== ''))) {
      return { headerRow: row, headerIndex: rowIndex };
    }
  }

  return null;
}

function inferDateFromText(textValue, fallbackYear = null) {
  if (!textValue) return null;
  const text = String(textValue).toLowerCase();
  const monthMatch = text.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/);
  const yearMatch = text.match(/\b(20\d{2})\b/);
  if (!monthMatch) return null;
  const monthNames = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  };
  const monthKey = monthMatch[1].slice(0, 3);
  const month = monthNames[monthKey];
  if (!month) return null;
  const year = yearMatch ? yearMatch[1] : fallbackYear;
  if (!year) return null;
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

function inferPivotDate(fileName, sheetName) {
  return (
    inferDateFromText(fileName) ||
    inferDateFromText(sheetName) ||
    inferDateFromText(sheetName, new Date().getFullYear())
  );
}

function isSummaryRow(value) {
  if (!value) return false;
  const normalized = String(value).trim().toLowerCase();
  return /^total\b/.test(normalized) || /^grand total\b/.test(normalized) || /^subtotal\b/.test(normalized);
}

function parsePivotFile(rawRows, formattedRows, headerRow, headerIndex, fileName, sheetName) {
  const resourceIndex = headerRow.findIndex((cell) => normaliseHeader(cell) === 'resourceName');
  if (resourceIndex === -1) {
    throw Object.assign(new Error('Pivot-style import requires a header for employee name in the first row.'), { statusCode: 422 });
  }

  const projectColumns = headerRow
    .map((cell, idx) => ({ header: String(cell || '').trim(), index: idx }))
    .filter((col) => {
      if (col.header === '') return false;
      if (col.index === resourceIndex) return false;
      // Skip any other employee-metadata column (e.g. "Name" when "Employee Code" is the identifier)
      if (normaliseHeader(col.header) === 'resourceName') return false;
      return true;
    });

  if (projectColumns.length === 0) {
    throw Object.assign(new Error('Pivot-style import requires at least one project column after the name column.'), { statusCode: 422 });
  }

  const inferredDate = inferPivotDate(fileName, sheetName);
  if (!inferredDate) {
    logger.error('Timesheet pivot parser failed to infer date from file name or sheet name', {
      fileName,
      sheetName,
      headerIndex,
      resourceIndex,
      projectColumns: projectColumns.map((c) => c.header),
    });

    throw Object.assign(
      new Error(
        'Pivot-style import requires a month in the worksheet name (for example "Jun") or a month and year in the file name (for example "MAY 2026").'
      ),
      { statusCode: 422 }
    );
  }

  const parsed = [];
  rawRows.slice(headerIndex + 1).forEach((row, rowIndex) => {
    const resourceName = String(row[resourceIndex] ?? '').trim();
    if (!resourceName || isSummaryRow(resourceName)) return;

    projectColumns.forEach((column) => {
      const rawVal = row[column.index];
      const formattedVal = (formattedRows && formattedRows[headerIndex + 1 + rowIndex])
        ? formattedRows[headerIndex + 1 + rowIndex][column.index]
        : undefined;

      let hours = parseHours(rawVal);
      // If numeric/raw parse yields zero, try parsing the formatted text (e.g. "00:07:30")
      if ((hours === null || hours === 0) && formattedVal) {
        hours = parseHours(formattedVal);
      }

      if (hours === null || hours < 0) return;

      parsed.push({
        rowNumber: rowIndex + 2,
        resourceName,
        projectHeader: column.header,
        servicePOName: '',
        subProject: '',
        date: inferredDate,
        hoursRaw: formattedVal !== undefined && formattedVal !== '' ? formattedVal : rawVal,
        hours,
      });
    });
  });

  if (parsed.length === 0) {
    const debugRows = rawRows.slice(headerIndex + 1).map((row, rowIndex) => ({
      rowNumber: headerIndex + 2 + rowIndex,
      resourceName: String(row[resourceIndex] ?? '').trim(),
      projects: projectColumns.map((column) => {
        const rawValue = row[column.index];
        const formattedValue = (formattedRows && formattedRows[headerIndex + 1 + rowIndex])
          ? formattedRows[headerIndex + 1 + rowIndex][column.index]
          : undefined;
        return {
          header: column.header,
          rawValue,
          formattedValue,
          parsedHours: parseHours(rawValue) || (formattedValue ? parseHours(formattedValue) : 0),
        };
      }),
    }));

    logger.error('Timesheet pivot parser found no valid rows', {
      fileName,
      headerIndex,
      resourceIndex,
      projectColumns: projectColumns.map((c) => c.header),
      scannedRows: rawRows.length - (headerIndex + 1),
      debugRows,
    });

    throw Object.assign(new Error('Pivot-style import file contained no valid employee/project hours rows.'), { statusCode: 422 });
  }

  logger.debug('Timesheet pivot parser completed', {
    fileName,
    sheetName,
    headerIndex,
    resourceIndex,
    projectColumns: projectColumns.map((c) => c.header),
    parsedRows: parsed.length,
    inferredDate,
  });

  return { rows: parsed, sheetName };
}

/**
 * Parse an uploaded .xlsx or .csv file and return a normalised array of row objects.
 * Each object has: { resourceName, servicePOName, subProject, date, hours }
 *
 * @param {string} filePath  - Absolute path to the uploaded file
 * @param {string} fileName  - Original file name, used for pivot imports
 * @param {string} mimetype  - MIME type from multer
 * @returns {Promise<object[]>}
 */
const parseFile = async (filePath, fileName, mimetype) => {
  const ext = path.extname(filePath).toLowerCase();

  // ── CSV via xlsx (handles both .csv and .xlsx) ────────────────────────────
  // Read workbook with `raw: true` to preserve underlying Excel cell values
  // (numbers for day-fractions) and avoid automatic JS Date conversions
  // that introduce timezone/format inconsistencies.
  const workbook = xlsx.readFile(filePath, {
    raw: true,
  });

  const sheetNames = workbook.SheetNames || [];
  if (!sheetNames.length) {
    throw Object.assign(new Error('The uploaded file contains no worksheets.'), { statusCode: 422 });
  }

  const allowedSheets = new Set([
    'jan', 'feb', 'mar', 'apr', 'may', 'jun',
    'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
  ]);

  const invalidSheet = sheetNames.find((name) => !allowedSheets.has(String(name).trim().toLowerCase()));
  if (invalidSheet) {
    throw Object.assign(
      new Error(
        `Invalid worksheet name "${invalidSheet}". ` +
        'Only sheets named Jan, Feb, Mar, Apr, May, Jun, Jul, Aug, Sep, Oct, Nov, Dec are accepted.'
      ),
      { statusCode: 422 }
    );
  }

  const sheetName = sheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  // Convert to array-of-arrays to manually handle headers.
  // `rawRows` preserves underlying Excel cell values (numbers for day-fractions).
  const rawRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  // `formattedRows` gives the display/formatted text (e.g. "00:07:30").
  const formattedRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });

  logger.debug('Timesheet parse file metadata', {
    fileName,
    sheetNames,
    sheetName,
    rowCount: rawRows.length,
  });

  if (!rawRows || rawRows.length < 2) {
    throw Object.assign(
      new Error('The file has no data rows. Ensure the first row contains headers and subsequent rows contain data.'),
      { statusCode: 422 }
    );
  }

  const headerResult = findHeaderRow(rawRows);
  if (!headerResult) {
    logger.error('Timesheet parse header detection failed', {
      fileName,
      sheetName,
      topRows: rawRows.slice(0, 5).map((row) => row.map((cell) => String(cell || '').trim())),
    });

    throw Object.assign(
      new Error(
        'Unable to locate the header row. Ensure the sheet contains a header row with employee name and either a standard timesheet layout or pivot-style project columns.'
      ),
      { statusCode: 422 }
    );
  }

  const { headerRow, headerIndex } = headerResult;
  logger.debug('Timesheet parse header detected', {
    fileName,
    sheetName,
    headerIndex,
    headerRow: headerRow.map((cell) => String(cell || '').trim()),
  });

  // Log first data row raw values for troubleshooting time cell types
  if (rawRows.length > headerIndex + 1) {
    logger.debug('Timesheet parse sample raw row', {
      fileName,
      sampleRow: rawRows[headerIndex + 1].slice(0, 6),
    });
  }
  const fieldIndex = {};
  headerRow.forEach((cell, idx) => {
    const fieldName = normaliseHeader(cell);
    if (fieldName && !(fieldName in fieldIndex)) {
      fieldIndex[fieldName] = idx;
    }
  });

  const requiredFields = ['resourceName', 'servicePOName', 'date', 'hours'];
  const missingHeaders = requiredFields.filter((f) => !(f in fieldIndex));
  const isPivotCandidate =
    'resourceName' in fieldIndex &&
    !('servicePOName' in fieldIndex) &&
    !('date' in fieldIndex) &&
    !('hours' in fieldIndex);

  if (missingHeaders.length > 0) {
    if (isPivotCandidate && headerRow.length > 2) {
      return parsePivotFile(rawRows, formattedRows, headerRow, headerIndex, fileName, sheetName);
    }

    throw Object.assign(
      new Error(
        `Missing required column(s): ${missingHeaders.join(', ')}. ` +
        `Expected headers: "Resource Name", "Service PO Name", "Date", "Hours".`
      ),
      { statusCode: 422 }
    );
  }

  const dataRows = rawRows.slice(headerIndex + 1);
  const parsed = [];

  dataRows.forEach((row, i) => {
    // Skip entirely empty rows
    if (row.every((cell) => cell === '' || cell === null || cell === undefined)) {
      return;
    }

    const get = (field) => {
      const idx = fieldIndex[field];
      return idx !== undefined ? row[idx] : undefined;
    };

    parsed.push({
      rowNumber: i + 2, // +2: 1-based + skip header
      resourceName:  String(get('resourceName') ?? '').trim(),
      servicePOName: String(get('servicePOName') ?? '').trim(),
      subProject:    String(get('subProject') ?? '').trim(),
      projectHeader: '',
      date:          parseDate(get('date')),
      hoursRaw:      get('hours'),
      hours:         parseHours(get('hours')) || 0,
    });
  });

  return { rows: parsed, sheetName };
};

const MONTHLY_TARGET_HOURS = 176;

// Returns true for rows that must NOT be scaled:
//   - zero hours (00:00)
//   - service type contains leave / vacation / holiday keywords
//   - service type or PO name contains "bench" (On Bench)
function isExcludedFromAdjustment(row) {
  if (row.hours <= 0) return true;
  const st = (row.serviceTypeName || '').toLowerCase();
  const po = (row.servicePOName  || '').toLowerCase();
  return (
    st.includes('leave') || st.includes('vacation') || st.includes('holiday') ||
    st.includes('bench') ||
    po.includes('leave') || po.includes('bench')
  );
}

/**
 * Proportionally scale each employee's adjustable hours so they sum to 176.
 * Excluded rows (zero, leaves, on-bench) are left untouched.
 * Uses the largest-remainder method so the distribution is always whole hours
 * summing to exactly 176.
 *
 * @param {object[]} validRows
 * @returns {object[]}
 */
function adjustHoursTo176(validRows) {
  // Group rows by employee
  const empGroups = new Map();
  for (const row of validRows) {
    if (!empGroups.has(row.employeeId)) empGroups.set(row.employeeId, []);
    empGroups.get(row.employeeId).push(row);
  }

  const result = [];

  for (const [, rows] of empGroups) {
    const adjustable = rows.filter(r => !isExcludedFromAdjustment(r));
    const excluded   = rows.filter(r =>  isExcludedFromAdjustment(r));

    const adjustableTotal = adjustable.reduce((sum, r) => sum + r.hours, 0);

    // Nothing to scale — either no adjustable rows or already exactly 176
    if (adjustable.length === 0 || adjustableTotal === 0 || adjustableTotal === MONTHLY_TARGET_HOURS) {
      result.push(...rows);
      continue;
    }

    const scale = MONTHLY_TARGET_HOURS / adjustableTotal;
    const rawScaled = adjustable.map(r => r.hours * scale);

    // Largest-remainder method: distribute exactly 176 whole hours
    const floored = rawScaled.map(v => Math.floor(v));
    const deficit = MONTHLY_TARGET_HOURS - floored.reduce((a, b) => a + b, 0);
    const byRemainder = rawScaled
      .map((v, i) => ({ i, rem: v - floored[i] }))
      .sort((a, b) => b.rem - a.rem);
    for (let k = 0; k < deficit; k++) {
      floored[byRemainder[k].i] += 1;
    }

    result.push(
      ...adjustable.map((row, i) => ({ ...row, hours: floored[i] })),
      ...excluded,
    );
  }

  return result;
}

/**
 * Validate a parsed array of rows against the database.
 *
 * For each row checks:
 *  1. Required fields present
 *  2. Date is valid
 *  3. Hours > 0 and <= 24
 *  4. Employee exists by full_name (case-insensitive) and is active
 *  5. Service PO exists by service_po_name (case-insensitive) and is active
 *  6. Sub-project (if provided) exists and belongs to the resolved PO
 *  7. No duplicate entry exists in the timesheets table
 *
 * @param {object[]} rows - Output from parseFile()
 * @returns {Promise<{ validRows: object[], errorRows: object[] }>}
 */
const validateRows = async (rows) => {
  const validRows = [];
  const errorRows = [];

  // Pre-fetch all active employees and POs to minimise N+1 queries
  const [allEmployees, allPOs] = await Promise.all([
    Employee.findAll({
      where: { status: 'active', is_deleted: false },
      attributes: ['id', 'full_name', 'employee_code', 'status'],
    }),
    ServicePO.findAll({
      where: {
        status: ['in-progress', 'on-hold', 'pending'],
        is_deleted: false,
      },
      attributes: ['id', 'service_po_name', 'status'],
      include: [
        {
          model: SubProject,
          as: 'subProjects',
          attributes: ['id', 'sub_project_name', 'status'],
          required: false,
        },
        {
          model: ServiceType,
          as: 'serviceType',
          attributes: ['id', 'service_type_name'],
          required: false,
        },
      ],
    }),
  ]);

  // Build lookup maps (lower-cased name -> record)
  const employeeMap = new Map();
  allEmployees.forEach((e) => {
    employeeMap.set(e.employee_code.trim().toLowerCase(), e);
  });

  const poMap = new Map();
  allPOs.forEach((po) => {
    poMap.set(po.service_po_name.trim().toLowerCase(), po);
  });

  for (const row of rows) {
    const errors = [];
    const { rowNumber, resourceName, servicePOName, subProject, projectHeader, date, hours } = row;
    const projectLabel = servicePOName || projectHeader;

    // 1. Required fields
    if (!resourceName) errors.push('Resource Name is required.');
    if (!projectLabel) errors.push('Service PO Name or project header is required.');
    if (!date) errors.push('Date is missing or could not be parsed. Expected format: YYYY-MM-DD or DD/MM/YYYY.');

    // 2. Hours validation (allow zero hours to match Excel uploads)
    const numericHours = parseFloat(hours);
    if (isNaN(numericHours) || numericHours < 0) {
      errors.push('Hours must be a number greater than or equal to 0.');
    }
    // No upper bound check — monthly working hours may be greater than 24.

    // 3. Date validity
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      errors.push(`Date "${date}" is not a valid date.`);
    }

    let employee = null;
    let po = null;
    let subProjectRecord = null;

    // 4. Employee lookup
    if (resourceName) {
      employee = employeeMap.get(resourceName.toLowerCase());
      if (!employee) {
        errors.push(`Employee with code "${resourceName}" was not found in the system.`);
      }
    }

    // 5. Service PO / Sub-project lookup
    const lookupLabel = projectLabel.toLowerCase();
    if (lookupLabel) {
      po = poMap.get(lookupLabel);
      if (!po) {
        const subProjectMatch = allPOs
          .flatMap((poItem) => (poItem.subProjects || []).map((sp) => ({ po: poItem, subProject: sp })))
          .find((entry) => entry.subProject.sub_project_name.trim().toLowerCase() === lookupLabel);

        if (subProjectMatch) {
          po = subProjectMatch.po;
          subProjectRecord = subProjectMatch.subProject;
        } else if (projectHeader && projectHeader.includes(' - ')) {
          const [candidatePO, candidateSP] = projectHeader.split(' - ', 2).map((text) => text.trim().toLowerCase());
          const foundPO = poMap.get(candidatePO);
          if (foundPO) {
            po = foundPO;
            subProjectRecord = (foundPO.subProjects || []).find(
              (sp) => sp.sub_project_name.trim().toLowerCase() === candidateSP
            );
          }
        } else if (projectHeader && projectHeader.includes('/')) {
          const [candidatePO, candidateSP] = projectHeader.split('/').map((text) => text.trim().toLowerCase());
          const foundPO = poMap.get(candidatePO);
          if (foundPO) {
            po = foundPO;
            subProjectRecord = (foundPO.subProjects || []).find(
              (sp) => sp.sub_project_name.trim().toLowerCase() === candidateSP
            );
          }
        }
      }

      if (!po) {
        errors.push(`Service PO or sub-project "${projectLabel}" was not found or is not available for timesheet logging.`);
      }
    }

    // 6. Sub-project lookup (optional)
    if (subProject && po) {
      const spLower = subProject.toLowerCase();
      subProjectRecord = (po.subProjects || []).find(
        (sp) => sp.sub_project_name.trim().toLowerCase() === spLower
      );
      if (!subProjectRecord) {
        errors.push(
          `Sub-project "${subProject}" was not found under Service PO "${po ? po.service_po_name : servicePOName || projectHeader}".`
        );
      }
    }

    if (errors.length > 0) {
      errorRows.push({
        rowNumber,
        row: {
          resourceName,
          servicePOName,
          subProject,
          date,
          hours,
        },
        errors,
      });
    } else {
      validRows.push({
        rowNumber,
        employeeId:      employee.id,
        poId:            po.id,
        subProjectId:    subProjectRecord ? subProjectRecord.id : null,
        date,
        hours:           numericHours,
        // Original display data for preview
        resourceName,
        servicePOName,
        serviceTypeName: po.serviceType ? po.serviceType.service_type_name : '',
        subProjectName:  subProjectRecord ? subProjectRecord.sub_project_name : null,
      });
    }
  }

  return { validRows, errorRows };
};

/**
 * Parse the file, validate all rows, persist an import history record
 * (status = 'pending'), store any error rows, and return a preview object.
 *
 * @param {string} filePath
 * @param {string} fileName   - Original file name
 * @param {number} userId     - Authenticated user ID
 * @param {string} mimetype
 * @returns {Promise<{ importId, totalRows, validRows, errorRows, preview }>}
 */
const previewImport = async (filePath, fileName, userId, mimetype, importMonth, importYear) => {
  logger.info('Timesheet import preview started', { userId, fileName, importMonth, importYear });

  // 1. Parse file
  let parsedRows;
  let displayFileName = fileName;

  try {
    const { rows, sheetName } = await parseFile(filePath, fileName, mimetype);
    parsedRows = rows;
    // Rename the stored file_name to "<SheetName><ext>" (e.g. "Jan.xlsx")
    displayFileName = sheetName + path.extname(fileName);
  } catch (err) {
    logger.error('Timesheet file parse error', { error: err.message, fileName });
    throw err;
  }

  // 2. Validate
  const { validRows: rawValidRows, errorRows } = await validateRows(parsedRows);

  // 3. Adjust each employee's adjustable hours to sum to 176
  const validRows = adjustHoursTo176(rawValidRows);

  // 4. Create import history record (status = pending)
  const importRecord = await timesheetImportRepository.createImportHistory({
    imported_by:  userId,
    file_name:    displayFileName,
    file_path:    filePath,
    total_rows:   parsedRows.length,
    valid_rows:   validRows.length,
    error_rows:   errorRows.length,
    status:       'pending',
    import_month: importMonth,
    import_year:  importYear,
  });

  // 5. Persist error rows if any
  if (errorRows.length > 0) {
    const errorInserts = errorRows.map((e) => ({
      import_id:     importRecord.id,
      row_number:    e.rowNumber,
      row_data:      e.row,
      error_message: e.errors.join(' | '),
    }));
    await timesheetImportRepository.createImportErrors(errorInserts);
  }

  logger.info('Timesheet import preview complete', {
    importId:   importRecord.id,
    totalRows:  parsedRows.length,
    validRows:  validRows.length,
    errorRows:  errorRows.length,
  });

  return {
    importId:  importRecord.id,
    fileName:  displayFileName,
    totalRows: parsedRows.length,
    validRows: validRows.length,
    errorRows: errorRows.length,
    preview:   validRows,
    errors:    errorRows,
    canConfirm: validRows.length > 0,
  };
};

/**
 * Confirm a pending import: bulk-insert all valid rows and mark the
 * import history record as completed.
 *
 * Uses a database transaction so the operation is all-or-nothing.
 *
 * @param {number} importId
 * @param {number} userId
 * @param {string} [ipAddress]
 * @returns {Promise<{ importId, insertedRows }>}
 */
const confirmImport = async (importId, userId, ipAddress = null) => {
  // 1. Load the pending import record
  const importRecord = await timesheetImportRepository.findImportById(importId);

  if (!importRecord) {
    const err = new Error(`Import record #${importId} not found.`);
    err.statusCode = 404;
    throw err;
  }

  if (importRecord.status !== 'pending') {
    const err = new Error(
      `Import #${importId} has already been ${importRecord.status}. Only pending imports can be confirmed.`
    );
    err.statusCode = 409;
    throw err;
  }

  if (importRecord.valid_rows === 0) {
    const err = new Error(
      'This import has no valid rows. Nothing to insert.'
    );
    err.statusCode = 422;
    throw err;
  }

  // 2. Re-parse the original file and re-validate to get current valid rows
  //    (guards against race conditions between preview and confirm)
  let parsedRows;
  try {
    const { rows } = await parseFile(importRecord.file_path, importRecord.file_name, null);
    parsedRows = rows;
  } catch (err) {
    await timesheetImportRepository.updateImportHistory(importId, { status: 'failed' });
    throw err;
  }

  const { validRows: rawValidRows, errorRows } = await validateRows(parsedRows);
  const validRows = adjustHoursTo176(rawValidRows);

  if (validRows.length === 0) {
    await timesheetImportRepository.updateImportHistory(importId, {
      status:     'failed',
      valid_rows: 0,
      error_rows: errorRows.length,
    });
    const err = new Error('Re-validation found no valid rows. Import aborted.');
    err.statusCode = 422;
    throw err;
  }

  // 3. Mark as processing
  await timesheetImportRepository.updateImportHistory(importId, { status: 'processing' });

  // 4. Bulk-insert inside a transaction
  const t = await sequelize.transaction();

  try {
    const records = validRows.map((row) => ({
      employee_id:         row.employeeId,
      service_po_id:       row.poId,
      sub_project_id:      row.subProjectId || null,
      timesheet_date:      row.date,
      hours_logged:        row.hours,
      created_by:          userId,
      updated_by:          userId,
      timesheet_import_id: importId,
    }));

    // Full-replace: the new file is the single source of truth for the month.
    // 1. Collect old import IDs before wiping timesheets (FK will SET NULL after delete).
    // 2. Delete all timesheets for the month.
    // 3. Delete the old import history records (errors cascade automatically).
    const firstDate  = records[0].timesheet_date; // "YYYY-MM-DD"
    const importYear  = parseInt(firstDate.slice(0, 4), 10);
    const importMonth = parseInt(firstDate.slice(5, 7), 10);

    const oldImportIds = await timesheetRepository.getImportIdsByMonth(importMonth, importYear, t);
    const deleted = await timesheetRepository.deleteByMonth(importMonth, importYear, t);
    const deletedHistory = await timesheetImportRepository.deleteImportsByIds(oldImportIds, importId, t);
    logger.info('Timesheet full-replace: cleared month', { importId, importMonth, importYear, deleted, deletedHistory });

    const inserted = await timesheetRepository.bulkCreate(records, t);

    // 5. Update history: completed (also stamp month/year from actual data)
    await timesheetImportRepository.updateImportHistory(importId, {
      status:       'completed',
      valid_rows:   inserted.length,
      error_rows:   errorRows.length,
      import_month: importMonth,
      import_year:  importYear,
    });

    // Persist any new error rows found on re-validation
    if (errorRows.length > 0) {
      const errorInserts = errorRows.map((e) => ({
        import_id:     importId,
        row_number:    e.rowNumber,
        row_data:      e.row,
        error_message: e.errors.join(' | '),
      }));
      await timesheetImportRepository.createImportErrors(errorInserts);
    }

    await t.commit();

    // 6. Audit log (non-blocking)
    createAuditLog(
      userId,
      'IMPORT',
      'timesheets',
      importId,
      null,
      { importId, insertedRows: inserted.length },
      ipAddress
    );

    logger.info('Timesheet import confirmed', {
      importId,
      userId,
      insertedRows: inserted.length,
    });

    return {
      importId,
      insertedRows: inserted.length,
      errorRows:    errorRows.length,
    };
  } catch (err) {
    await t.rollback();
    await timesheetImportRepository.updateImportHistory(importId, { status: 'failed' });
    logger.error('Timesheet import confirm failed', {
      importId,
      error: err.message,
    });
    throw err;
  }
};

/**
 * Return a paginated list of all import history records.
 * @param {object} query - Express req.query
 * @returns {Promise<{ data, meta }>}
 */
const getImportHistory = async (query = {}) => {
  const { page, limit, offset } = getPaginationParams(query);
  const { rows, count } = await timesheetImportRepository.findAllImports({ limit, offset });
  return {
    data: rows,
    meta: getPaginationMeta(count, page, limit),
  };
};

/**
 * Return a single import history record with its error rows.
 * @param {number} id
 * @returns {Promise<TimesheetImportHistory>}
 */
const getImportById = async (id) => {
  const record = await timesheetImportRepository.findImportById(id);
  if (!record) {
    const err = new Error(`Import record #${id} not found.`);
    err.statusCode = 404;
    throw err;
  }
  return record;
};

// ── Single-record CRUD helpers used by timesheetController ───────────────────

/**
 * Create a single timesheet entry (manual entry path).
 * @param {object} data  - { employee_id, service_po_id, sub_project_id?, timesheet_date, hours_logged, created_by }
 * @returns {Promise<Timesheet>}
 */
const createTimesheet = async (data) => {
  const duplicate = await timesheetRepository.checkDuplicate(
    data.employee_id,
    data.service_po_id,
    data.timesheet_date
  );
  if (duplicate) {
    const err = new Error(
      `A timesheet entry already exists for employee #${data.employee_id} on ${data.timesheet_date} under PO #${data.service_po_id}.`
    );
    err.statusCode = 409;
    throw err;
  }
  return timesheetRepository.create(data);
};

/**
 * Update an existing timesheet entry.
 * Re-checks for duplicates when the date, employee, or PO changes.
 * @param {number} id
 * @param {object} data
 * @returns {Promise<Timesheet>}
 */
const updateTimesheet = async (id, data) => {
  const existing = await timesheetRepository.findById(id);
  if (!existing) {
    const err = new Error(`Timesheet #${id} not found.`);
    err.statusCode = 404;
    throw err;
  }

  // Only check duplicate if key fields changed
  const checkEmpId  = data.employee_id   ?? existing.employee_id;
  const checkPoId   = data.service_po_id ?? existing.service_po_id;
  const checkDate   = data.timesheet_date ?? existing.timesheet_date;

  const duplicate = await timesheetRepository.checkDuplicate(checkEmpId, checkPoId, checkDate, id);
  if (duplicate) {
    const err = new Error(
      `A timesheet entry already exists for employee #${checkEmpId} on ${checkDate} under PO #${checkPoId}.`
    );
    err.statusCode = 409;
    throw err;
  }

  return timesheetRepository.update(id, data);
};

/**
 * Delete a timesheet entry.
 * @param {number} id
 * @returns {Promise<void>}
 */
const deleteTimesheet = async (id) => {
  const rows = await timesheetRepository.deleteById(id);
  if (rows === 0) {
    const err = new Error(`Timesheet #${id} not found.`);
    err.statusCode = 404;
    throw err;
  }
};

/**
 * Fetch paginated timesheets with filters.
 * @param {object} query - Express req.query
 * @returns {Promise<{ data, meta }>}
 */
const getAllTimesheets = async (query = {}) => {
  const { page, limit, offset } = getPaginationParams(query);
  const { startDate, endDate, employeeId, poId, subProjectId, sortBy, sortOrder } = query;

  const { rows, count } = await timesheetRepository.findAll(
    { startDate, endDate, employeeId, poId, subProjectId },
    { limit, offset },
    { sortBy, sortOrder }
  );

  return {
    data: rows,
    meta: getPaginationMeta(count, page, limit),
  };
};

/**
 * Fetch a single timesheet by ID.
 * @param {number} id
 * @returns {Promise<Timesheet>}
 */
const getTimesheetById = async (id) => {
  const record = await timesheetRepository.findById(id);
  if (!record) {
    const err = new Error(`Timesheet #${id} not found.`);
    err.statusCode = 404;
    throw err;
  }
  return record;
};

/**
 * Fetch all timesheet rows that belong to a specific import batch.
 * @param {number} importId
 * @returns {Promise<Timesheet[]>}
 */
const getImportRows = async (importId) => {
  const id = parseInt(importId, 10);
  if (isNaN(id) || id < 1) {
    const err = new Error('Invalid import ID.');
    err.statusCode = 400;
    throw err;
  }

  const rows = await timesheetRepository.findByImportBatch(id);
  return rows;
};

module.exports = {
  parseFile: parseFile,
  validateRows: validateRows,
  previewImport: previewImport,
  confirmImport: confirmImport,
  getImportHistory: getImportHistory,
  getImportById: getImportById,
  getImportRows: getImportRows,
  createTimesheet: createTimesheet,
  updateTimesheet: updateTimesheet,
  deleteTimesheet: deleteTimesheet,
  getAllTimesheets: getAllTimesheets,
  getTimesheetById: getTimesheetById,
};
