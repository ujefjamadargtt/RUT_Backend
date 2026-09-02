'use strict';

const xlsx = require('xlsx');
const { Client } = require('../models');
const { generateClientCode } = require('../helpers/codeGenerator');
const { resolveCreateCompanyIdForActor } = require('./companyAccessControlService');
const logger = require('../utils/logger');

// ── Header map (case-insensitive, trimmed) ────────────────────────────────────
const HEADER_MAP = {
  'client name':   'client_name',
  'name':          'client_name',
  'client':        'client_name',
  'client_name':   'client_name',
  'customer name': 'client_name',
  'customer':      'client_name',
  'client code':   'client_code',
  'code':          'client_code',
  'client_code':   'client_code',
  'clt code':      'client_code',
  'clt_code':      'client_code',
  'industry':      'industry',
  'sector':        'industry',
  'industry name': 'industry',
  'industry_name': 'industry',
  'status':        'status',
};

function normaliseHeader(cell) {
  if (!cell) return null;
  return HEADER_MAP[String(cell).trim().toLowerCase()] || null;
}

/**
 * Find the header row by scanning the first 5 rows.
 * The row must contain at least one recognised column AND a client_name variant.
 */
function findHeaderRow(rows) {
  const nameVariants = new Set([
    'client name', 'name', 'client', 'client_name', 'customer name', 'customer',
  ]);
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const normalised = rows[i].map((cell) => String(cell || '').trim().toLowerCase());
    const hasName    = normalised.some((v) => nameVariants.has(v));
    const recognised = normalised.filter((v) => HEADER_MAP[v]).length;
    if (hasName && recognised >= 1) {
      return { headerRow: rows[i], headerIndex: i };
    }
  }
  return null;
}

/**
 * Validate a single parsed row.
 * Returns { errors[], clientName, clientCode, industry, status }.
 */
function validateRow(data) {
  const errors = [];

  const clientName = String(data.client_name || '').trim();
  if (!clientName) {
    errors.push('Client Name is required.');
  } else if (clientName.length < 2) {
    errors.push('Client Name must be at least 2 characters.');
  } else if (clientName.length > 100) {
    errors.push('Client Name must not exceed 100 characters.');
  }

  const clientCode = data.client_code
    ? String(data.client_code).trim().toUpperCase()
    : null;
  if (clientCode) {
    if (clientCode.length < 2 || clientCode.length > 20) {
      errors.push('Client Code must be between 2 and 20 characters.');
    } else if (!/^[A-Z0-9_\-]{2,20}$/.test(clientCode)) {
      errors.push('Client Code may only contain uppercase letters, digits, underscores, or hyphens.');
    }
  }

  const industry = data.industry ? String(data.industry).trim() : null;
  if (industry && industry.length > 100) {
    errors.push('Industry must not exceed 100 characters.');
  }

  const statusRaw = data.status ? String(data.status).trim().toLowerCase() : 'active';
  const status    = ['active', 'inactive'].includes(statusRaw) ? statusRaw : null;
  if (!status) {
    errors.push(`Status must be "active" or "inactive". Got: "${data.status}".`);
  }

  return { errors, clientName, clientCode, industry, status: status || 'active' };
}

/**
 * Parse an Excel/CSV file and bulk-import clients.
 *
 * Rules:
 *  - client_name is required; duplicates (DB or within-file) are skipped.
 *  - client_code is optional; auto-generated (CLT-YYYYMMDD-XXXX) if absent.
 *  - Rows that fail validation are reported in error_rows.
 *  - Duplicate rows (name or code already exists) are also reported with skipped=true.
 *
 * @param {string} filePath
 * @param {number} userId
 * @param {import('express').Request} req - for resolveCreateCompanyId: a
 *   BU-scoped actor's own req.companyId always wins; a company-less
 *   Admin/Entity Admin must supply `company_id` in the multipart form body,
 *   validated against their own owned Companies — replaces the previous
 *   raw `req.companyId` passthrough, which crashed for those actors.
 * @returns {Promise<{ total, imported, skipped, error_rows }>}
 */
async function importClients(filePath, userId, req) {
  const bodyCompanyId = req.body && req.body.company_id ? parseInt(req.body.company_id, 10) : null;
  const companyId = await resolveCreateCompanyIdForActor(req, bodyCompanyId, { required: true, resourceLabel: 'a Client import' });
  logger.info('Client import started', { userId, companyId, filePath });

  // ── Parse workbook ──────────────────────────────────────────────────────────
  const workbook = xlsx.readFile(filePath, { raw: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw Object.assign(new Error('The uploaded file contains no worksheets.'), { statusCode: 422 });
  }

  const rawRows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    defval: '',
  });

  if (!rawRows || rawRows.length < 2) {
    throw Object.assign(
      new Error('The file has no data rows. Ensure the first row contains headers.'),
      { statusCode: 422 }
    );
  }

  // ── Locate header row ───────────────────────────────────────────────────────
  const headerResult = findHeaderRow(rawRows);
  if (!headerResult) {
    throw Object.assign(
      new Error(
        'Unable to locate the header row. ' +
        'Ensure the sheet has a column named "Client Name" (or "Name", "Customer Name").'
      ),
      { statusCode: 422 }
    );
  }

  const { headerRow, headerIndex } = headerResult;

  const fieldIndex = {};
  headerRow.forEach((cell, idx) => {
    const field = normaliseHeader(cell);
    if (field && !(field in fieldIndex)) fieldIndex[field] = idx;
  });

  if (!('client_name' in fieldIndex)) {
    throw Object.assign(
      new Error('Missing required column "Client Name".'),
      { statusCode: 422 }
    );
  }

  // ── Pre-fetch existing clients for duplicate detection (scoped to this
  // company — uniqueness is per-company, not global) ─────────────────────────
  const existingClients = await Client.findAll({
    where: { company_id: companyId },
    attributes: ['client_name', 'client_code'],
    raw: true,
  });

  const existingNames = new Set(existingClients.map((c) => c.client_name.trim().toLowerCase()));
  const existingCodes = new Set(existingClients.map((c) => c.client_code.trim().toLowerCase()));

  // Within-file duplicate trackers
  const fileNames = new Set();
  const fileCodes = new Set();

  // ── Process data rows ───────────────────────────────────────────────────────
  const dataRows  = rawRows.slice(headerIndex + 1);
  const nonEmpty  = dataRows.filter((r) => r.some((c) => c !== '' && c !== null && c !== undefined));
  const total     = nonEmpty.length;

  let imported = 0;
  let skipped  = 0;
  const error_rows = [];

  const getCell = (row, field) => {
    const idx = fieldIndex[field];
    return idx !== undefined ? row[idx] : undefined;
  };

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];

    // Skip entirely empty rows
    if (row.every((c) => c === '' || c === null || c === undefined)) continue;

    const rowNumber = headerIndex + i + 2; // 1-based, skip header

    const rawData = {
      client_name: getCell(row, 'client_name'),
      client_code: getCell(row, 'client_code'),
      industry:    getCell(row, 'industry'),
      status:      getCell(row, 'status'),
    };

    const { errors, clientName, clientCode, industry, status } = validateRow(rawData);

    if (errors.length > 0) {
      error_rows.push({ row_number: rowNumber, row_data: rawData, errors });
      continue;
    }

    // ── Duplicate checks ────────────────────────────────────────────────────
    if (fileNames.has(clientName.toLowerCase())) {
      skipped++;
      error_rows.push({
        row_number: rowNumber,
        row_data:   rawData,
        errors:     [`Duplicate client name "${clientName}" within the file.`],
        skipped:    true,
      });
      continue;
    }

    if (existingNames.has(clientName.toLowerCase())) {
      skipped++;
      error_rows.push({
        row_number: rowNumber,
        row_data:   rawData,
        errors:     [`Client with name "${clientName}" already exists in the system.`],
        skipped:    true,
      });
      continue;
    }

    if (clientCode) {
      const codeLower = clientCode.toLowerCase();
      if (existingCodes.has(codeLower) || fileCodes.has(codeLower)) {
        skipped++;
        error_rows.push({
          row_number: rowNumber,
          row_data:   rawData,
          errors:     [`Client code "${clientCode}" is already in use.`],
          skipped:    true,
        });
        continue;
      }
    }

    // ── Auto-generate code if absent ────────────────────────────────────────
    let finalCode = clientCode;
    if (!finalCode) {
      let attempts = 0;
      do {
        finalCode = generateClientCode();
        attempts++;
      } while (
        (existingCodes.has(finalCode.toLowerCase()) || fileCodes.has(finalCode.toLowerCase())) &&
        attempts < 10
      );

      if (existingCodes.has(finalCode.toLowerCase()) || fileCodes.has(finalCode.toLowerCase())) {
        error_rows.push({
          row_number: rowNumber,
          row_data:   rawData,
          errors:     ['Failed to generate a unique client code. Please try again.'],
        });
        continue;
      }
    }

    // ── Insert ───────────────────────────────────────────────────────────────
    try {
      await Client.create({
        client_name: clientName,
        client_code: finalCode,
        industry:    industry || null,
        status,
        company_id:  companyId,
        created_by:  userId,
        updated_by:  userId,
      });

      // Register in in-memory sets so later rows in the same file detect dupes
      existingNames.add(clientName.toLowerCase());
      existingCodes.add(finalCode.toLowerCase());
      fileNames.add(clientName.toLowerCase());
      fileCodes.add(finalCode.toLowerCase());

      imported++;
    } catch (err) {
      logger.error('Client import row insert failed', { rowNumber, error: err.message });
      error_rows.push({
        row_number: rowNumber,
        row_data:   rawData,
        errors:     [`Database error: ${err.message}`],
      });
    }
  }

  logger.info('Client import completed', {
    userId,
    total,
    imported,
    skipped,
    errors: error_rows.length - skipped,
  });

  return { total, imported, skipped, error_rows };
}

module.exports = { importClients };
