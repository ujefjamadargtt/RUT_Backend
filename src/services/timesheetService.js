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
const { applyHoursVisibility } = require('../utils/hoursVisibility');
const employeeWorkLogRepository = require('../repositories/employeeWorkLogRepository');
const timesheetPublishPolicy = require('../utils/timesheetPublishPolicy');

/**
 * Map EmployeeWorkLog rows (Employee Self Timesheet module — ALL rows for
 * the month, regardless of status; see employeeWorkLogRepository.findForSync)
 * into the exact row shape parseFile() produces for an Excel row, so they
 * flow untouched through the existing validateRows()/adjustHoursTo176()
 * import pipeline. This is the ONLY place the "Sync Employee Work Logs"
 * flow reads source data from — never from `timesheets`.
 *
 * @param {import('../models').EmployeeWorkLog[]} workLogs
 * @returns {object[]}
 */
function mapWorkLogsToImportRows(workLogs) {
  return workLogs.map((log, index) => ({
    rowNumber: index + 1,
    resourceName: log.employee?.employee_code,
    servicePOName: log.servicePO?.service_po_name,
    subProject: log.subProject?.sub_project_name,
    date: log.work_date,
    hours: parseFloat(log.hours),
    isWorking: true,
  }));
}

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
  'is working':       'isWorking',
  'isworking':        'isWorking',
  'is_working':       'isWorking',
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
 * Parse an "Is Working" cell value (t/f/true/false/1/0/yes/no) to boolean.
 * Absent or unrecognised values default to true (employee is considered working).
 * @param {*} raw
 * @returns {boolean}
 */
function parseIsWorking(raw) {
  if (raw === undefined || raw === null || raw === '') return true;
  const v = String(raw).trim().toLowerCase();
  if (v === 'f' || v === 'false' || v === '0' || v === 'no') return false;
  return true;
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

  // Column index for "Is Working" flag (-1 if absent)
  const isWorkingIndex = headerRow.findIndex((cell) => normaliseHeader(cell) === 'isWorking');

  const projectColumns = headerRow
    .map((cell, idx) => ({ header: String(cell || '').trim(), index: idx }))
    .filter((col) => {
      if (col.header === '') return false;
      if (col.index === resourceIndex) return false;
      // Skip any other employee-metadata column (e.g. "Name" when "Employee Code" is the identifier)
      if (normaliseHeader(col.header) === 'resourceName') return false;
      // Skip the "Is Working" metadata column — not a project
      if (col.index === isWorkingIndex) return false;
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

    // Per-employee "Is Working" flag (true if column absent)
    const isWorking = isWorkingIndex !== -1 ? parseIsWorking(row[isWorkingIndex]) : true;

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
        isWorking,
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
      isWorking:     parseIsWorking(get('isWorking')),
    });
  });

  return { rows: parsed, sheetName };
};

const MONTHLY_TARGET_HOURS = 176;

// Returns true for rows that must NOT be scaled (kept as original Excel value):
//   - zero hours (00:00)
//   - Leaves / vacation / holiday
//   - On Bench
//   - Idle
// Detection checks both the resolved project label (Excel column header) and
// the service type name from the DB so pivot and flat formats both work.
function isExcludedFromAdjustment(row) {
  if (row.hours <= 0) return true;
  const st  = (row.serviceTypeName || '').toLowerCase();
  const prj = (row.projectLabel    || row.servicePOName || '').toLowerCase();
  return (
    prj.includes('leave')   || prj.includes('vacation') || prj.includes('holiday') ||
    prj.includes('bench')   || prj.includes('idle') ||
    st.includes('leave')    || st.includes('vacation') || st.includes('holiday') ||
    st.includes('bench')    || st.includes('idle')
  );
}

/**
 * Proportionally scale each employee's adjustable hours so their monthly
 * total is exactly 176 — but only when it currently exceeds 176.
 *
 * Algorithm (employee-wise, applied after all of an employee's rows for the
 * import are known):
 *   totalHours            = sum of every row's hours
 *   -> if totalHours <= 176: no change at all.
 *   leaveHours            = sum of hours on rows excluded from adjustment —
 *                           Leave / Vacation / Holiday / Bench / Idle / any
 *                           row that already has 0 hours (isExcludedFromAdjustment).
 *                           These NEVER change, and a 0-hour row never becomes non-zero.
 *   workingHours          = totalHours - leaveHours   (== sum of adjustable rows)
 *   allowedWorkingHours   = 176 - leaveHours
 *   ratio                 = allowedWorkingHours / workingHours
 *   each adjustable (non-Leave, hours > 0) row's hours = row.hours * ratio
 *
 * A largest-remainder distribution at hundredths-of-an-hour precision is
 * used instead of independent per-row rounding, so the adjusted rows sum to
 * EXACTLY allowedWorkingHours — meaning the employee's grand total lands on
 * exactly 176, not "176 plus or minus a rounding cent".
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
    // If any row for this employee is marked "Is Working = false", keep all
    // their hours exactly as uploaded — do not adjust to 176.
    if (rows.some(r => r.isWorking === false)) {
      result.push(...rows);
      continue;
    }

    const totalHours = rows.reduce((sum, r) => sum + r.hours, 0);

    // Requirement: totals at or under the monthly target are never touched.
    if (totalHours <= MONTHLY_TARGET_HOURS) {
      result.push(...rows);
      continue;
    }

    // Leave / Vacation / Holiday / Bench / Idle / 0-hour rows — never adjusted.
    const excluded = rows.filter(r => isExcludedFromAdjustment(r));
    // Non-Leave POs with hours > 0 — the only rows that ever get rescaled.
    const adjustable = rows.filter(r => !isExcludedFromAdjustment(r));

    const leaveHours          = excluded.reduce((sum, r) => sum + r.hours, 0);
    const workingHours        = totalHours - leaveHours; // == sum of adjustable hours
    const allowedWorkingHours = MONTHLY_TARGET_HOURS - leaveHours;

    // Nothing adjustable, or Leave alone already meets/exceeds the 176 cap —
    // the ratio would be undefined or negative, so leave hours untouched.
    if (adjustable.length === 0 || workingHours <= 0 || allowedWorkingHours <= 0) {
      result.push(...rows);
      continue;
    }

    const ratio = allowedWorkingHours / workingHours;

    // Largest-remainder method at hundredths-of-an-hour precision: guarantees
    // the adjusted rows sum to exactly allowedWorkingHours (not just "close").
    const targetHundredths = Math.round(allowedWorkingHours * 100);
    const rawHundredths = adjustable.map(r => r.hours * ratio * 100);
    const flooredHundredths = rawHundredths.map(v => Math.floor(v));
    const deficit = targetHundredths - flooredHundredths.reduce((a, b) => a + b, 0);
    const byRemainder = rawHundredths
      .map((v, i) => ({ i, rem: v - flooredHundredths[i] }))
      .sort((a, b) => b.rem - a.rem);
    for (let k = 0; k < deficit; k++) {
      flooredHundredths[byRemainder[k].i] += 1;
    }

    result.push(
      ...adjustable.map((row, i) => ({ ...row, hours: flooredHundredths[i] / 100 })),
      ...excluded,
    );
  }

  return result;
}

/**
 * Detect rows within the same file that share the same employee + Service PO
 * + date — the exact combination the database's own unique constraint
 * enforces on the timesheets table. Reporting only: does not remove or alter
 * any row, so callers can surface these for review without blocking import.
 *
 * @param {object[]} validRows - Output from validateRows() (post-adjustment)
 * @returns {object[]} duplicates: [{ employeeId, resourceName, poId, servicePOName, date, rows, occurrences }]
 */
function detectDuplicateRows(validRows) {
  const keyMap = new Map(); // "employeeId|poId|date" -> [rowNumber, ...]

  for (const row of validRows) {
    const key = `${row.employeeId}|${row.poId}|${row.date}`;
    if (!keyMap.has(key)) keyMap.set(key, []);
    keyMap.get(key).push(row.rowNumber);
  }

  const duplicates = [];
  for (const [key, rowNumbers] of keyMap) {
    if (rowNumbers.length <= 1) continue;
    const [employeeIdStr, poIdStr, date] = key.split('|');
    const sample = validRows.find((r) => r.rowNumber === rowNumbers[0]);
    duplicates.push({
      employeeId: parseInt(employeeIdStr, 10),
      resourceName: sample.resourceName,
      poId: parseInt(poIdStr, 10),
      servicePOName: sample.projectLabel || sample.servicePOName,
      date,
      rows: rowNumbers,
      occurrences: rowNumbers.length,
    });
  }

  return duplicates;
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
 * @param {number} companyId
 * @returns {Promise<{ validRows: object[], errorRows: object[] }>}
 */
const validateRows = async (rows, companyId) => {
  const validRows = [];
  const errorRows = [];

  // Pre-fetch all active employees and POs, scoped to this company, to
  // minimise N+1 queries. Without the company_id filter, an employee_code
  // or service_po_name valid in another company would silently resolve
  // here even for a different company's upload — this was a real,
  // confirmed cross-tenant bug.
  const [allEmployees, allPOs] = await Promise.all([
    Employee.findAll({
      where: { status: 'active', is_deleted: false, company_id: companyId },
      attributes: ['id', 'full_name', 'employee_code', 'status'],
    }),
    ServicePO.findAll({
      where: {
        status: timesheetRepository.ELIGIBLE_PO_STATUSES,
        is_deleted: false,
        company_id: companyId,
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
    const { rowNumber, resourceName, servicePOName, subProject, projectHeader, date, hours, isWorking } = row;
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
      logger.warn('Timesheet validateRows row failed', {
        rowNumber, resourceName, projectLabel, date, hours, errors,
      });
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
        projectLabel,    // resolved label (servicePOName for flat, projectHeader for pivot)
        serviceTypeName: po.serviceType ? po.serviceType.service_type_name : '',
        subProjectName:  subProjectRecord ? subProjectRecord.sub_project_name : null,
        isWorking:       isWorking !== false, // default true if column was absent
      });
    }
  }

  return { validRows, errorRows };
};

/**
 * Log an aggregated breakdown of validation failures so a large batch of
 * errors is diagnosable from the terminal at a glance. Groups by a
 * normalized version of each error message (the specific employee/PO/date
 * value replaced with a placeholder), since raw messages are almost all
 * unique per row (e.g. a different employee name in each one).
 *
 * @param {object[]} errorRows - from validateRows()
 * @param {object} context     - extra fields to include in the log (e.g. fileName, importId)
 */
function logErrorRowBreakdown(errorRows, context = {}) {
  if (errorRows.length === 0) return;

  const reasonCounts = {};
  for (const e of errorRows) {
    for (const msg of e.errors) {
      const normalized = msg.replace(/"[^"]*"/g, '"X"');
      reasonCounts[normalized] = (reasonCounts[normalized] || 0) + 1;
    }
  }

  logger.warn('Timesheet import failure breakdown', {
    ...context,
    totalErrorRows: errorRows.length,
    reasonCounts,
  });
}

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
const previewImport = async (filePath, fileName, userId, mimetype, importMonth, importYear, companyId) => {
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

  return runImportPreview(parsedRows, {
    fileName: displayFileName,
    filePath,
    userId,
    importMonth,
    importYear,
    companyId,
    source: 'excel',
  });
};

// Same 3-letter month naming convention Excel imports already use — the
// display file_name is derived from the sheet name ("Jan", "Feb", ...) plus
// the uploaded file's extension (see previewImport()'s displayFileName).
// The Sync flow has no uploaded file/sheet name to derive from, so it
// generates the same convention directly from the selected month.
const MONTH_ABBREVIATIONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Preview a "Sync Employee Work Logs" run: reads every row from
 * `employee_work_logs` (Employee Self Timesheet module) for the selected
 * company/month/year instead of parsing an uploaded file, maps them into
 * parseFile()'s row shape, then runs through the EXACT SAME validate ->
 * 176h-adjust -> duplicate-detect -> import-history pipeline
 * runImportPreview() already applies to Excel uploads — only the row
 * source changes, per the "reuse the complete existing Import Timesheet
 * business logic, do not duplicate" requirement. Never reads `timesheets`.
 *
 * Idempotent by design: there must only ever be ONE Sync import per
 * Company + Month + Year. If one already exists (from an earlier sync of
 * this same period), runImportPreview() UPDATES that same row instead of
 * creating a new one — Sync behaves as an overwrite, not an append.
 *
 * @param {number} month
 * @param {number} year
 * @param {number} userId
 * @param {number} companyId
 * @returns {Promise<{ importId, totalRows, validRows, errorRows, preview, errors, duplicates, canConfirm }>}
 */
const previewPmsImport = async (month, year, userId, companyId) => {
  logger.info('Employee Work Log sync preview started', { userId, month, year, companyId });

  const workLogs = await employeeWorkLogRepository.findForSync(companyId, month, year);
  const parsedRows = mapWorkLogsToImportRows(workLogs);

  // Find-or-update: reuse the existing Sync import for this
  // company+month+year (any source='pms' record, whatever its status) so a
  // repeat sync never creates a second import history row for the same period.
  const existing = await timesheetImportRepository.findByMonthYearSource(companyId, month, year, 'pms');

  return runImportPreview(parsedRows, {
    fileName: `${MONTH_ABBREVIATIONS[month - 1]}.xlsx`,
    filePath: null,
    userId,
    importMonth: month,
    importYear: year,
    companyId,
    source: 'pms',
    existingImportId: existing ? existing.id : null,
  });
};

/**
 * Shared body of the import preview flow: validate -> adjust hours to 176
 * -> detect duplicates -> create/update import history (status = pending)
 * -> persist error rows -> build the preview response. Extracted from
 * previewImport() so previewPmsImport() (Sync Employee Work Logs) can reuse
 * it verbatim instead of duplicating any of this logic — the only
 * difference between an Excel upload and a Sync is where `parsedRows`
 * came from.
 *
 * `meta.existingImportId` (optional): when provided, the import history
 * record with that ID is UPDATED in place (its prior error rows are
 * cleared first) instead of a new row being created — this is what makes
 * repeat syncs of the same Company+Month+Year an overwrite rather than an
 * append. Excel uploads never pass this — their behavior is unchanged.
 *
 * @param {object[]} parsedRows - rows in the shape parseFile() produces
 * @param {object} meta - { fileName, filePath, userId, importMonth, importYear, companyId, source, existingImportId? }
 * @returns {Promise<{ importId, fileName, totalRows, validRows, errorRows, preview, errors, duplicates, canConfirm }>}
 */
const runImportPreview = async (parsedRows, meta) => {
  const { fileName, filePath, userId, importMonth, importYear, companyId, source = 'excel', existingImportId = null } = meta;

  // 2. Validate
  const { validRows: rawValidRows, errorRows } = await validateRows(parsedRows, companyId);
  logErrorRowBreakdown(errorRows, { fileName, stage: 'preview' });

  // 3. Adjust each employee's adjustable hours to sum to 176
  const validRows = adjustHoursTo176(rawValidRows);

  // 3b. Detect (not block) rows sharing the same employee + PO + date
  const duplicates = detectDuplicateRows(validRows);
  if (duplicates.length > 0) {
    logger.warn('Timesheet import preview: duplicate employee+PO+date rows detected', {
      duplicateCount: duplicates.length,
      duplicates,
    });
  }

  // 4. Create OR update the import history record (status = pending)
  let importRecord;
  if (existingImportId) {
    // Overwrite path: clear this import's previous error rows first so
    // they don't accumulate across repeat sync attempts, then update the
    // SAME row in place — no new timesheet_import_history record.
    await timesheetImportRepository.deleteErrorsByImportIds([existingImportId], null, companyId);
    importRecord = await timesheetImportRepository.updateImportHistory(existingImportId, {
      imported_by:  userId,
      file_name:    fileName,
      file_path:    filePath,
      total_rows:   parsedRows.length,
      valid_rows:   validRows.length,
      error_rows:   errorRows.length,
      status:       'pending',
      import_month: importMonth,
      import_year:  importYear,
    }, null, companyId);
  } else {
    importRecord = await timesheetImportRepository.createImportHistory({
      imported_by:  userId,
      file_name:    fileName,
      file_path:    filePath,
      total_rows:   parsedRows.length,
      valid_rows:   validRows.length,
      error_rows:   errorRows.length,
      status:       'pending',
      import_month: importMonth,
      import_year:  importYear,
      company_id:   companyId,
      source,
    });
  }

  // 5. Persist error rows if any
  if (errorRows.length > 0) {
    const errorInserts = errorRows.map((e) => ({
      import_id:     importRecord.id,
      row_number:    e.rowNumber,
      row_data:      e.row,
      error_message: e.errors.join(' | '),
      company_id:    companyId,
    }));
    await timesheetImportRepository.createImportErrors(errorInserts);
  }

  logger.info('Timesheet import preview complete', {
    importId:   importRecord.id,
    totalRows:  parsedRows.length,
    validRows:  validRows.length,
    errorRows:  errorRows.length,
    source,
  });

  return {
    importId:  importRecord.id,
    fileName,
    totalRows: parsedRows.length,
    validRows: validRows.length,
    errorRows: errorRows.length,
    preview:   validRows,
    errors:    errorRows,
    duplicates,
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
const confirmImport = async (importId, userId, ipAddress = null, companyId) => {
  // 1. Load the pending import record
  const importRecord = await timesheetImportRepository.findImportById(importId, companyId);

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

  // 2. Re-fetch/re-parse the source rows and re-validate to get current
  //    valid rows (guards against race conditions between preview and
  //    confirm). Branches on `source`: an Excel-sourced import re-parses
  //    the file stored on disk (unchanged); a PMS-sourced import (i.e. a
  //    "Sync Employee Work Logs" run) re-reads employee_work_logs rows
  //    instead — everything downstream of this point is identical for
  //    both sources.
  let parsedRows;
  try {
    if (importRecord.source === 'pms') {
      const workLogs = await employeeWorkLogRepository.findForSync(
        companyId,
        importRecord.import_month,
        importRecord.import_year
      );
      parsedRows = mapWorkLogsToImportRows(workLogs);
    } else {
      const { rows } = await parseFile(importRecord.file_path, importRecord.file_name, null);
      parsedRows = rows;
    }
  } catch (err) {
    await timesheetImportRepository.updateImportHistory(importId, { status: 'failed' }, null, companyId);
    throw err;
  }

  const { validRows: rawValidRows, errorRows } = await validateRows(parsedRows, companyId);
  logErrorRowBreakdown(errorRows, { fileName: importRecord.file_name, importId, stage: 'confirm' });
  const validRows = adjustHoursTo176(rawValidRows);

  // Detect (not block) rows sharing the same employee + PO + date. Note this
  // combination is also enforced by the timesheets table's own unique
  // constraint, so if duplicates remain unresolved the bulk insert below will
  // fail — this is reported for visibility only, it does not deduplicate.
  const duplicates = detectDuplicateRows(validRows);
  if (duplicates.length > 0) {
    logger.warn('Timesheet import confirm: duplicate employee+PO+date rows detected', {
      importId,
      duplicateCount: duplicates.length,
      duplicates,
    });
  }

  if (validRows.length === 0) {
    await timesheetImportRepository.updateImportHistory(importId, {
      status:     'failed',
      valid_rows: 0,
      error_rows: errorRows.length,
    }, null, companyId);
    const err = new Error('Re-validation found no valid rows. Import aborted.');
    err.statusCode = 422;
    throw err;
  }

  // 3. Mark as processing
  await timesheetImportRepository.updateImportHistory(importId, { status: 'processing' }, null, companyId);

  // 4. Bulk-insert inside a transaction
  const t = await sequelize.transaction();

  try {
    // Resolved ONCE per import (not per row) — every row in the same
    // confirm belongs to the same company, so is_publish is identical
    // across the whole batch. See timesheetPublishPolicy.js for the rule
    // itself (company-level, not per-user/per-role).
    const isPublish = await timesheetPublishPolicy.resolveInitialIsPublish(companyId);

    const records = validRows.map((row) => ({
      employee_id:         row.employeeId,
      service_po_id:       row.poId,
      sub_project_id:      row.subProjectId || null,
      timesheet_date:      row.date,
      hours_logged:        row.hours,
      // modified_hours always starts out equal to hours_logged on creation
      // — set here in application code, never left null.
      modified_hours:      row.hours,
      is_publish:          isPublish,
      company_id:          companyId,
      created_by:          userId,
      updated_by:          userId,
      timesheet_import_id: importId,
    }));

    // Full-replace: the new file is the single source of truth for the
    // month, FOR THIS COMPANY. 1. Collect old import IDs before wiping
    // timesheets (FK will SET NULL after delete). 2. Delete all timesheets
    // for the month IN THIS COMPANY. 3. Delete the old import history
    // records (errors cascade automatically). Without the company_id scope
    // on steps 1-2 this would wipe every other company's timesheets for the
    // same month too — this was a real, confirmed data-loss bug.
    const firstDate  = records[0].timesheet_date; // "YYYY-MM-DD"
    const importYear  = parseInt(firstDate.slice(0, 4), 10);
    const importMonth = parseInt(firstDate.slice(5, 7), 10);

    const oldImportIds = await timesheetRepository.getImportIdsByMonth(importMonth, importYear, t, companyId);
    const deleted = await timesheetRepository.deleteByMonth(importMonth, importYear, t, companyId);
    const deletedHistory = await timesheetImportRepository.deleteImportsByIds(oldImportIds, importId, t, companyId);
    logger.info('Timesheet full-replace: cleared month', { importId, importMonth, importYear, deleted, deletedHistory, companyId });

    const inserted = await timesheetRepository.bulkCreate(records, t);

    // 5. Update history: completed (also stamp month/year from actual data).
    // is_publish uses the SAME `isPublish` value just stamped onto every
    // `records` row above — one resolution, applied to both tables, so
    // they can never disagree (see timesheetPublishPolicy.js).
    await timesheetImportRepository.updateImportHistory(importId, {
      status:       'completed',
      valid_rows:   inserted.length,
      error_rows:   errorRows.length,
      import_month: importMonth,
      import_year:  importYear,
      is_publish:   isPublish,
    }, null, companyId);

    // Persist any new error rows found on re-validation
    if (errorRows.length > 0) {
      const errorInserts = errorRows.map((e) => ({
        import_id:     importId,
        row_number:    e.rowNumber,
        row_data:      e.row,
        error_message: e.errors.join(' | '),
        company_id:    companyId,
      }));
      await timesheetImportRepository.createImportErrors(errorInserts);
    }

    // For a "Sync Employee Work Logs" import, flip the source
    // employee_work_logs rows to 'synced' in the SAME transaction as the
    // timesheets insert — either both commit or both roll back, so a draft
    // row can never be left 'pending' after its official record exists (or
    // vice versa).
    if (importRecord.source === 'pms') {
      const tuples = validRows.map((row) => ({ employeeId: row.employeeId, poId: row.poId, date: row.date }));
      const syncedCount = await employeeWorkLogRepository.markSyncedByTuples(companyId, tuples, importId, t);
      logger.info('Employee work logs marked as synced', { importId, syncedCount });
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
      duplicates,
    };
  } catch (err) {
    await t.rollback();
    await timesheetImportRepository.updateImportHistory(importId, { status: 'failed' }, null, companyId);
    logger.error('Timesheet import confirm failed', {
      importId,
      error: err.message,
    });
    throw err;
  }
};

/**
 * Return a paginated list of all import history records, optionally filtered
 * by month/year, each annotated with total_employees — the count of distinct
 * employees covered by that import batch.
 *
 * @param {object} query - Express req.query, may include { month, year }
 * @returns {Promise<{ data, meta }>}
 */
const getImportHistory = async (query = {}, companyId) => {
  const { page, limit, offset } = getPaginationParams(query);

  const month = query.month ? parseInt(query.month, 10) : undefined;
  const year = query.year ? parseInt(query.year, 10) : undefined;

  const { rows, count } = await timesheetImportRepository.findAllImports(
    { limit, offset },
    { month, year, companyId }
  );

  const importIds = rows.map((r) => r.id);
  const employeeCounts = await timesheetImportRepository.getEmployeeCountsByImportIds(importIds, companyId);

  const data = rows.map((r) => {
    const plain = r.toJSON();
    plain.total_employees = employeeCounts.get(r.id) || 0;
    return plain;
  });

  return {
    data,
    meta: getPaginationMeta(count, page, limit),
  };
};

/**
 * Return a single import history record with its error rows.
 * @param {number} id
 * @returns {Promise<TimesheetImportHistory>}
 */
const getImportById = async (id, companyId) => {
  const record = await timesheetImportRepository.findImportById(id, companyId);
  if (!record) {
    const err = new Error(`Import record #${id} not found.`);
    err.statusCode = 404;
    throw err;
  }
  return record;
};

// ── Single-record CRUD helpers used by timesheetController ───────────────────

/**
 * Safely pull a calendar year/month out of either a plain "YYYY-MM-DD"
 * string or a native JS Date object. Never uses String(date) on a Date —
 * Date.prototype.toString() is a locale-style string ("Tue Sep 01 2026..."),
 * not ISO, so naively splitting it on "-" silently produces NaN, which then
 * corrupts any raw SQL it's interpolated into. Date components are read via
 * the UTC getters (not local time) because Joi.date() parses an ISO
 * date-only string as UTC midnight — reading local getters could shift the
 * day in a timezone behind UTC.
 *
 * @param {string|Date} date
 * @returns {{ year: number, month: number }} month is 1-12
 */
function extractYearMonth(date) {
  if (date instanceof Date) {
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
  }
  const [year, month] = String(date).split('-');
  return { year: parseInt(year, 10), month: parseInt(month, 10) };
}

/**
 * Shared core behind every "employee hours cannot exceed 176" rule: adds the
 * requested hours to whatever's already been logged, and throws a 400 with a
 * caller-supplied message if that total exceeds MONTHLY_TARGET_HOURS.
 * Extracted so validateMonthlyHoursLimit() (month/year-scoped) and
 * validateImportHoursLimit() (timesheet_import_id-scoped) share the exact
 * same arithmetic/threshold/error-shape instead of each reimplementing it.
 *
 * @param {number} existingHours
 * @param {number} hoursRequested
 * @param {(total: number) => string} buildMessage - given the rounded would-be total, returns the error message
 * @throws {Error} statusCode 400 if existingHours + hoursRequested > MONTHLY_TARGET_HOURS
 */
function assertHoursWithinCap(existingHours, hoursRequested, buildMessage) {
  const totalHours = existingHours + parseFloat(hoursRequested);
  if (totalHours > MONTHLY_TARGET_HOURS) {
    const err = new Error(buildMessage(Math.round(totalHours * 100) / 100));
    err.statusCode = 400;
    throw err;
  }
}

/**
 * Enforce the employee's 176-hour monthly cap (MONTHLY_TARGET_HOURS, the
 * same constant adjustHoursTo176() targets for Excel imports). Shared by the
 * manual create and update APIs so both apply the identical rule:
 *
 *   Total Monthly Hours = Existing Monthly Hours
 *                          (- Current Entry Hours, Update only)
 *                          + Requested Hours
 *
 * Existing Monthly Hours is summed only for the same employee and the same
 * month/year as `date` (timesheetRepository.getMonthlyHours). The
 * `timesheets` table has no soft-delete flag — every row is a live record —
 * so there is nothing additional to filter out here.
 *
 * `date` may arrive as either a plain "YYYY-MM-DD" string (e.g. from
 * existing.timesheet_date, which Sequelize returns as a string for a
 * DATEONLY column) or a native JS Date object — the `validate` middleware's
 * Joi schemas use Joi.date().iso() with convert:true, which coerces a valid
 * ISO date string into an actual Date before the controller/service ever
 * see it. extractYearMonth() below handles both without ever naively
 * String()-ing a Date object (whose default toString() is NOT ISO format,
 * e.g. "Tue Sep 01 2026 00:00:00 GMT+...", not "2026-09-01").
 *
 * @param {object} params
 * @param {number} params.employeeId
 * @param {string|Date} params.date              - determines which month/year to sum
 * @param {number} params.hoursRequested         - the hours this create/update would add
 * @param {number} [params.excludeTimesheetId]   - Update only: the record being edited, excluded
 *   from "Existing Monthly Hours" so its old hours aren't counted alongside the new value
 * @throws {Error} statusCode 400 if the resulting monthly total would exceed MONTHLY_TARGET_HOURS
 */
const validateMonthlyHoursLimit = async ({ employeeId, date, hoursRequested, excludeTimesheetId = null, companyId }) => {
  const { year, month } = extractYearMonth(date);

  const existingHours = await timesheetRepository.getMonthlyHours(
    month,
    year,
    employeeId,
    excludeTimesheetId,
    companyId
  );

  assertHoursWithinCap(existingHours, hoursRequested, (total) =>
    `Employee total monthly hours cannot exceed ${MONTHLY_TARGET_HOURS}. ` +
    `Current total after this request would be ${total} hours.`
  );
};

/**
 * Enforce the employee's 176-hour cap scoped to one specific monthly sheet
 * (timesheet_import_id), for the manual create API: when an Admin backfills
 * an entry that belongs to an already-uploaded monthly sheet, the entry is
 * tagged with that same timesheet_import_id, and the employee's hours WITHIN
 * that one import must not exceed 176 — mirroring the same 176-hour rule
 * the Excel upload itself enforces per employee per import
 * (adjustHoursTo176), just checked against the one import being patched
 * instead of the calendar month.
 *
 * Reuses the same assertHoursWithinCap() core as validateMonthlyHoursLimit()
 * — only the existing-hours query and error wording differ.
 *
 * @param {object} params
 * @param {number} params.employeeId
 * @param {number} params.timesheetImportId
 * @param {number} params.hoursRequested - the hours this create would add
 * @throws {Error} statusCode 422 if timesheetImportId doesn't exist
 * @throws {Error} statusCode 400 if the resulting total for this import would exceed MONTHLY_TARGET_HOURS
 */
const validateImportHoursLimit = async ({ employeeId, timesheetImportId, hoursRequested, companyId }) => {
  const importRecord = await timesheetImportRepository.findImportById(timesheetImportId, companyId);
  if (!importRecord) {
    const err = new Error(`Timesheet Import History #${timesheetImportId} was not found.`);
    err.statusCode = 422;
    throw err;
  }

  const existingHours = await timesheetRepository.getImportHours(employeeId, timesheetImportId, companyId);

  assertHoursWithinCap(existingHours, hoursRequested, (total) =>
    `Employee total logged hours for the selected timesheet cannot exceed ${MONTHLY_TARGET_HOURS}. ` +
    `Current total after this request would be ${total} hours.`
  );
};

/**
 * Resolve and validate every entity referenced by a manual single-timesheet
 * create payload, using the exact same eligibility rules the Excel import's
 * validateRows() applies:
 *  - Employee must exist, be active, and not deleted (see step 4 above).
 *  - Service PO must exist, not be deleted, and have a loggable status (see
 *    step 5 above) — timesheetRepository.ELIGIBLE_PO_STATUSES is the same
 *    constant validateRows() filters its Service PO lookup by.
 *  - A given sub_project_id must belong to the resolved PO (see step 6 above).
 * Plus the extra cross-checks a free-form Admin Panel form needs that an
 * Excel row resolved purely by PO name can never violate by construction:
 *  - The selected project must belong to the selected client (client_id).
 *  - The selected Service Type must belong to the selected PO (service_type_id).
 *  - The selected Service Type must belong to the selected Service Category
 *    (service_category_id) — all three optional; each is only checked when
 *    the caller actually supplies it ("if applicable").
 *
 * @param {object} data - { employee_id, service_po_id, sub_project_id?, client_id?, service_type_id?, service_category_id? }
 * @returns {Promise<{ employee: object, po: object }>} the resolved records
 * @throws {Error} statusCode 422 — mirrors the wording/status validateRows() uses for the same failures
 */
const resolveManualEntryReferences = async (data, companyId) => {
  const employee = await timesheetRepository.findEligibleEmployeeById(data.employee_id, companyId);
  if (!employee) {
    const err = new Error(`Employee #${data.employee_id} was not found or is not active.`);
    err.statusCode = 422;
    throw err;
  }

  const po = await timesheetRepository.findEligibleServicePOById(data.service_po_id, companyId);
  if (!po) {
    const err = new Error(
      `Service PO #${data.service_po_id} was not found or is not available for timesheet logging.`
    );
    err.statusCode = 422;
    throw err;
  }

  if (data.client_id != null && po.client_id !== data.client_id) {
    const err = new Error(
      `Service PO "${po.service_po_name}" does not belong to client #${data.client_id}.`
    );
    err.statusCode = 422;
    throw err;
  }

  if (data.service_type_id != null && po.service_type_id !== data.service_type_id) {
    const err = new Error(
      `Service PO "${po.service_po_name}" is not associated with Service Type #${data.service_type_id}.`
    );
    err.statusCode = 422;
    throw err;
  }

  if (
    data.service_category_id != null &&
    po.serviceType?.service_category_id !== data.service_category_id
  ) {
    const err = new Error(
      `Service Type "${po.serviceType?.service_type_name || ''}" does not belong to Service Category #${data.service_category_id}.`
    );
    err.statusCode = 422;
    throw err;
  }

  if (data.sub_project_id) {
    const subProjectRecord = (po.subProjects || []).find((sp) => sp.id === data.sub_project_id);
    if (!subProjectRecord) {
      const err = new Error(
        `Sub-project #${data.sub_project_id} was not found under Service PO "${po.service_po_name}".`
      );
      err.statusCode = 422;
      throw err;
    }
  }

  return { employee, po };
};

/**
 * Create a single timesheet entry (manual entry path — e.g. backfilling a row
 * missing from an Excel upload). Resolves and validates every referenced
 * entity exactly as the Excel import does (resolveManualEntryReferences()),
 * then applies the same duplicate rule as the import: the DB's own
 * (employee_id, service_po_id, timesheet_date) unique constraint is the
 * final source of truth, checked here first for a friendly 409 instead of a
 * raw constraint-violation error.
 *
 * Note: the Excel import's 176-hour proportional adjustment
 * (adjustHoursTo176) is a whole-batch calculation across every row an
 * employee has in that import — it has no meaning for a single standalone
 * entry, so it is intentionally NOT applied here. The admin enters the exact
 * hours for the missing entry, same as what would have been in the original
 * (already-parsed) Excel cell.
 *
 * client_id / service_type_id / service_category_id are validation-only —
 * exactly like the Excel import, they are never stored on the timesheets
 * row itself, since they're already derivable via service_po_id's own
 * relationships (ServicePO -> Client, ServicePO -> ServiceType -> ServiceCategory).
 *
 * @param {object} data - { employee_id, service_po_id, sub_project_id?, client_id?, service_type_id?, service_category_id?, timesheet_date, hours_logged, created_by, updated_by }
 * @returns {Promise<Timesheet>}
 */
const createTimesheet = async (data, companyId) => {
  await resolveManualEntryReferences(data, companyId);

  const duplicate = await timesheetRepository.checkDuplicate(
    data.employee_id,
    data.service_po_id,
    data.timesheet_date,
    null,
    companyId
  );
  if (duplicate) {
    const err = new Error(
      `A timesheet entry already exists for employee #${data.employee_id} on ${data.timesheet_date} under PO #${data.service_po_id}.`
    );
    err.statusCode = 409;
    throw err;
  }

  await validateMonthlyHoursLimit({
    employeeId: data.employee_id,
    date: data.timesheet_date,
    hoursRequested: data.hours_logged,
    companyId,
  });

  await validateImportHoursLimit({
    employeeId: data.employee_id,
    timesheetImportId: data.timesheet_import_id,
    hoursRequested: data.hours_logged,
    companyId,
  });

  const { client_id, service_type_id, service_category_id, ...insertData } = data;
  // modified_hours always starts out equal to hours_logged on creation —
  // set here in application code (not a DB default/trigger) so it's never
  // left null on a new row. hours_logged itself is never touched by this.
  // is_publish is resolved from the company's own flag — see
  // timesheetPublishPolicy.js — not left at its DB default.
  insertData.modified_hours = insertData.hours_logged;
  insertData.is_publish = await timesheetPublishPolicy.resolveInitialIsPublish(companyId);
  insertData.company_id = companyId;
  return timesheetRepository.create(insertData);
};

/**
 * Update an existing timesheet entry.
 * Re-checks for duplicates when the date, employee, or PO changes.
 * @param {number} id
 * @param {object} data
 * @returns {Promise<Timesheet>}
 */
const updateTimesheet = async (id, data, companyId) => {
  const existing = await timesheetRepository.findById(id, companyId);
  if (!existing) {
    const err = new Error(`Timesheet #${id} not found.`);
    err.statusCode = 404;
    throw err;
  }

  // Only check duplicate if key fields changed
  const checkEmpId  = data.employee_id   ?? existing.employee_id;
  const checkPoId   = data.service_po_id ?? existing.service_po_id;
  const checkDate   = data.timesheet_date ?? existing.timesheet_date;
  const checkHours  = data.hours_logged  ?? existing.hours_logged;

  const duplicate = await timesheetRepository.checkDuplicate(checkEmpId, checkPoId, checkDate, id, companyId);
  if (duplicate) {
    const err = new Error(
      `A timesheet entry already exists for employee #${checkEmpId} on ${checkDate} under PO #${checkPoId}.`
    );
    err.statusCode = 409;
    throw err;
  }

  await validateMonthlyHoursLimit({
    employeeId: checkEmpId,
    date: checkDate,
    hoursRequested: checkHours,
    excludeTimesheetId: id,
    companyId,
  });

  return timesheetRepository.update(id, data, null, companyId);
};

/**
 * Set the admin-adjustable "Modified Hours" for a single timesheet entry
 * (PATCH /timesheets/:id/modified-hours, HR-only — a separate endpoint from
 * PUT /timesheets/:id, which never touches modified_hours/is_publish).
 *
 * hours_logged (the original, immutable value) is never modified here —
 * only modified_hours on this row, and is_publish on this row and its
 * parent monthly sheet (timesheet_import_history), both done in a single
 * transaction. If the row has no timesheet_import_id (not part of an
 * import batch), the parent update is skipped rather than erroring.
 * is_publish is a one-way flag — this only ever sets it true, never resets it.
 *
 * @param {number} id
 * @param {number} modifiedHours
 * @returns {Promise<Timesheet>} the updated timesheet row
 * @throws {Error} statusCode 404 if the timesheet doesn't exist
 */
const updateModifiedHours = async (id, modifiedHours, companyId) => {
  const existing = await timesheetRepository.findById(id, companyId);
  if (!existing) {
    const err = new Error(`Timesheet #${id} not found.`);
    err.statusCode = 404;
    throw err;
  }

  const t = await sequelize.transaction();
  let updated;
  try {
    updated = await timesheetRepository.update(
      id,
      { modified_hours: modifiedHours, is_publish: true },
      t,
      companyId
    );

    if (existing.timesheet_import_id) {
      await timesheetImportRepository.updateImportHistory(
        existing.timesheet_import_id,
        { is_publish: true },
        t,
        companyId
      );
    }

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }

  return updated;
};

/**
 * Bulk-update "Modified Hours" for several timesheet entries belonging to
 * ONE monthly import (PUT /timesheets/import/:timesheetImportId/hours,
 * HR-only). A dedicated, narrower sibling of updateModifiedHours() above —
 * this one only ever touches modified_hours and never is_publish; publishing
 * is a separate, deliberate action (see publishImport() below).
 *
 * Validation, in order, all BEFORE any write happens:
 *  1. The import must exist.
 *  2. Every `id` in `timesheets` must belong to THIS import — an id from a
 *     different import (or a nonexistent id) fails the whole request.
 *  3. The 176-hour cap (MONTHLY_TARGET_HOURS), enforced per employee, scoped
 *     to this one import — same rule/threshold as validateImportHoursLimit(),
 *     reusing the exact same assertHoursWithinCap() core, but computed
 *     differently since this is a bulk edit of EXISTING rows rather than one
 *     new row being added: for each employee touched by this batch, "existing
 *     hours" is the sum of that employee's OTHER rows in this import (rows
 *     not in this batch, using their current modified_hours — or hours_logged
 *     if modified_hours is still null) and "requested hours" is the sum of
 *     this batch's new values for that employee's rows in this import.
 *
 * Only after every row passes validation does the transaction open — one
 * UPDATE per row (timesheetRepository.update, transaction-aware), so a
 * failure partway through rolls back the entire batch. is_publish is never
 * touched here.
 *
 * @param {number} timesheetImportId
 * @param {{ id: number, hours: number }[]} timesheets
 * @returns {Promise<number>} count of rows updated
 * @throws {Error} statusCode 422 if the import doesn't exist or any id isn't part of it
 * @throws {Error} statusCode 400 if any affected employee's total would exceed MONTHLY_TARGET_HOURS
 */
const bulkUpdateImportModifiedHours = async (timesheetImportId, timesheets, companyId) => {
  const importRecord = await timesheetImportRepository.findImportById(timesheetImportId, companyId);
  if (!importRecord) {
    const err = new Error(`Timesheet Import History #${timesheetImportId} was not found.`);
    err.statusCode = 422;
    throw err;
  }

  const importRows = await timesheetRepository.findByImportBatch(timesheetImportId, companyId);
  const rowById = new Map(importRows.map((row) => [row.id, row]));

  const requestedById = new Map(timesheets.map((ts) => [ts.id, ts.hours]));
  const notInThisImport = timesheets.map((ts) => ts.id).filter((id) => !rowById.has(id));
  if (notInThisImport.length > 0) {
    const err = new Error(
      `Timesheet(s) not found in import #${timesheetImportId}: ${notInThisImport.join(', ')}.`
    );
    err.statusCode = 422;
    throw err;
  }

  // Split every row currently in the import into "existing" (kept as-is) vs
  // "requested" (this batch's new value) buckets, summed per employee, then
  // feed both sums into the same shared cap-check core every other hours
  // limit rule in this file uses.
  const existingByEmployee = new Map();
  const requestedByEmployee = new Map();
  for (const row of importRows) {
    const isInBatch = requestedById.has(row.id);
    const bucket = isInBatch ? requestedByEmployee : existingByEmployee;
    const amount = isInBatch ? requestedById.get(row.id) : (row.modified_hours ?? row.hours_logged);
    bucket.set(row.employee_id, (bucket.get(row.employee_id) || 0) + parseFloat(amount));
  }

  const touchedEmployeeIds = new Set(timesheets.map((ts) => rowById.get(ts.id).employee_id));
  for (const employeeId of touchedEmployeeIds) {
    assertHoursWithinCap(
      existingByEmployee.get(employeeId) || 0,
      requestedByEmployee.get(employeeId) || 0,
      (total) =>
        `Employee #${employeeId}'s total modified hours for import #${timesheetImportId} cannot exceed ` +
        `${MONTHLY_TARGET_HOURS}. Current total after this request would be ${total} hours.`
    );
  }

  const t = await sequelize.transaction();
  let updatedCount = 0;
  try {
    for (const { id, hours } of timesheets) {
      await timesheetRepository.update(id, { modified_hours: hours }, t, companyId);
      updatedCount += 1;
    }
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }

  return updatedCount;
};

/**
 * Publish an imported monthly sheet (PUT /timesheets/import/:timesheetImportId/publish,
 * HR-only). A dedicated sibling of bulkUpdateImportModifiedHours() above —
 * this one only ever touches is_publish and never modifies any hours field.
 *
 * Sets is_publish = true on the timesheet_import_history record AND on
 * every timesheets row belonging to it, in one transaction. is_publish is a
 * one-way flag (see updateModifiedHours() above) — if the import is already
 * published, this is a no-op that reports it back rather than writing again.
 *
 * @param {number} timesheetImportId
 * @returns {Promise<{ alreadyPublished: boolean }>}
 * @throws {Error} statusCode 422 if the import doesn't exist
 */
const publishImport = async (timesheetImportId, companyId) => {
  const importRecord = await timesheetImportRepository.findImportById(timesheetImportId, companyId);
  if (!importRecord) {
    const err = new Error(`Timesheet Import History #${timesheetImportId} was not found.`);
    err.statusCode = 422;
    throw err;
  }

  if (importRecord.is_publish) {
    return { alreadyPublished: true };
  }

  const t = await sequelize.transaction();
  try {
    await timesheetImportRepository.updateImportHistory(timesheetImportId, { is_publish: true }, t, companyId);
    await timesheetRepository.publishByImportId(timesheetImportId, t, companyId);
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }

  return { alreadyPublished: false };
};

/**
 * Delete a timesheet entry.
 * @param {number} id
 * @returns {Promise<void>}
 */
const deleteTimesheet = async (id, companyId) => {
  const rows = await timesheetRepository.deleteById(id, companyId);
  if (rows === 0) {
    const err = new Error(`Timesheet #${id} not found.`);
    err.statusCode = 404;
    throw err;
  }
};

/**
 * Delete one or many "monthly sheets" (timesheet import batches) in a single call.
 * Pass an array with a single ID to delete just one import, or many IDs to
 * delete several at once. For every import this removes:
 *   1. The child timesheet rows created by that import (timesheets.timesheet_import_id) —
 *      timesheets.timesheet_import_id is ON DELETE SET NULL, so these must be
 *      deleted explicitly rather than relying on the DB to cascade them.
 *   2. The child error rows for that import (timesheet_import_errors.import_id) —
 *      deleted explicitly for an accurate deletedErrorRows count, even though
 *      the FK is already ON DELETE CASCADE.
 *   3. The import history record itself (timesheet_import_history)
 *   4. The physical uploaded file on disk (file_path)
 *
 * This NEVER deletes Employee Work Logs (employee_work_logs) — they are the
 * source of truth, not the output of an import. Any work log rows that had
 * been synced into the import being deleted are instead reverted to
 * status='pending' (employeeWorkLogRepository.revertSyncStatusByImportIds,
 * step 0 below) so they remain intact and can be freely edited/re-synced —
 * the row itself is never touched.
 *
 * @param {number[]} ids
 * @returns {Promise<{ deletedImportCount: number, deletedTimesheetRows: number, deletedErrorRows: number, revertedWorkLogs: number, removedFiles: string[], failedFiles: object[] }>}
 */
const deleteImports = async (ids, companyId) => {
  const uniqueIds = [...new Set(ids)];

  const records = await timesheetImportRepository.findImportsByIds(uniqueIds, companyId);
  if (records.length === 0) {
    // Common mix-up: the caller passed a raw timesheets.id (a single day's
    // entry) instead of a timesheet_import_history.id ("Timesheet History ID" /
    // monthly sheet). The two are independent auto-increment sequences, so a
    // valid ID for one is almost always meaningless for the other.
    const matchingTimesheets = await timesheetRepository.findByIds(uniqueIds, companyId);
    if (matchingTimesheets.length > 0) {
      const err = new Error(
        `No matching monthly sheet(s) found to delete. ID(s) ${matchingTimesheets.map((r) => r.id).join(', ')} ` +
        `belong to individual timesheet entries, not a monthly sheet import. ` +
        `Use DELETE /api/v1/timesheets to delete individual timesheet entries.`
      );
      err.statusCode = 404;
      throw err;
    }

    const err = new Error('No matching import record(s) found to delete.');
    err.statusCode = 404;
    throw err;
  }

  const t = await sequelize.transaction();
  let deletedTimesheetRows;
  let deletedErrorRows;
  let deletedImportCount;
  let revertedWorkLogs;
  try {
    // Employee Work Logs are the source of truth and must remain intact
    // after a Timesheet Import is deleted — the official Timesheet data
    // for this import is about to disappear, so any work log rows this
    // import had synced are no longer accurately reflected anywhere and
    // must revert to status='pending' (not just have their FK nulled) so
    // they can be edited/deleted freely and picked up by a future sync.
    // Must run BEFORE deleting the import history rows below (defense in
    // depth: the FK's own ON DELETE SET NULL would clear the column
    // regardless, but only this step restores `status`).
    revertedWorkLogs = await employeeWorkLogRepository.revertSyncStatusByImportIds(uniqueIds, t);
    // Child table 1: timesheet rows belonging to these imports
    deletedTimesheetRows = await timesheetRepository.deleteByImportIds(uniqueIds, t, companyId);
    // Child table 2: error rows belonging to these imports — deleted explicitly
    // for an accurate count (the FK is already ON DELETE CASCADE).
    deletedErrorRows = await timesheetImportRepository.deleteErrorsByImportIds(uniqueIds, t, companyId);
    // Parent record(s)
    deletedImportCount = await timesheetImportRepository.deleteImportsById(uniqueIds, t, companyId);
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }

  // Best-effort removal of the physical uploaded file(s) from disk, after the
  // DB transaction has committed successfully.
  const removedFiles = [];
  const failedFiles = [];
  for (const record of records) {
    const filePath = record.file_path;
    if (!filePath) continue;
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        removedFiles.push(filePath);
      }
    } catch (fileErr) {
      failedFiles.push({ importId: record.id, filePath, error: fileErr.message });
      logger.error('Failed to delete timesheet import file from disk', {
        importId: record.id,
        filePath,
        error: fileErr.message,
      });
    }
  }

  return { deletedImportCount, deletedTimesheetRows, deletedErrorRows, revertedWorkLogs, removedFiles, failedFiles };
};

/**
 * Fetch paginated timesheets with filters.
 * @param {object} query - Express req.query
 * @returns {Promise<{ data, meta }>}
 */
const getAllTimesheets = async (query = {}, companyId) => {
  const { page, limit, offset } = getPaginationParams(query);
  const { startDate, endDate, employeeId, poId, subProjectId, sortBy, sortOrder, role } = query;

  const { rows, count } = await timesheetRepository.findAll(
    { startDate, endDate, employeeId, poId, subProjectId, companyId },
    { limit, offset },
    { sortBy, sortOrder }
  );

  return {
    data: applyHoursVisibility(rows, role),
    meta: getPaginationMeta(count, page, limit),
  };
};

/**
 * Fetch a single timesheet by ID.
 * @param {number} id
 * @param {string} [role] - from req.body.role/req.query.role, NOT the JWT — see hoursVisibility.js
 * @returns {Promise<object>}
 */
const getTimesheetById = async (id, role, companyId) => {
  const record = await timesheetRepository.findById(id, companyId);
  if (!record) {
    const err = new Error(`Timesheet #${id} not found.`);
    err.statusCode = 404;
    throw err;
  }
  return applyHoursVisibility([record], role)[0];
};

/**
 * Fetch all timesheet rows that belong to a specific import batch.
 * @param {number} importId
 * @param {string} [role] - from req.body.role/req.query.role, NOT the JWT — see hoursVisibility.js
 * @returns {Promise<object[]>}
 */
const getImportRows = async (importId, role, companyId) => {
  const id = parseInt(importId, 10);
  if (isNaN(id) || id < 1) {
    const err = new Error('Invalid import ID.');
    err.statusCode = 400;
    throw err;
  }

  const rows = await timesheetRepository.findByImportBatch(id, companyId);
  return applyHoursVisibility(rows, role);
};

module.exports = {
  parseFile: parseFile,
  validateRows: validateRows,
  previewImport: previewImport,
  previewPmsImport: previewPmsImport,
  confirmImport: confirmImport,
  getImportHistory: getImportHistory,
  getImportById: getImportById,
  getImportRows: getImportRows,
  createTimesheet: createTimesheet,
  updateTimesheet: updateTimesheet,
  updateModifiedHours: updateModifiedHours,
  bulkUpdateImportModifiedHours: bulkUpdateImportModifiedHours,
  publishImport: publishImport,
  deleteTimesheet: deleteTimesheet,
  deleteImports: deleteImports,
  getAllTimesheets: getAllTimesheets,
  getTimesheetById: getTimesheetById,

  // Exported for unit testing only — not part of the public service API.
  adjustHoursTo176,
  isExcludedFromAdjustment,
  resolveManualEntryReferences,
  validateMonthlyHoursLimit,
  validateImportHoursLimit,
};