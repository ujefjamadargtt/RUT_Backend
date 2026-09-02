'use strict';

const xlsx = require('xlsx');
const { Op } = require('sequelize');
const { Project, Client } = require('../models');
const { generateProjectCode } = require('../helpers/codeGenerator');
const {
  resolveCreateCompanyIdForActor,
  resolveOwnedCompanyIds,
} = require('./companyAccessControlService');
const logger = require('../utils/logger');

/**
 * Project Import Service
 * Mirrors clientImportService.js's shape/pattern. Every validation rule
 * here mirrors projectValidation.js/projectService.create() exactly, so a
 * row that would be rejected by the single-project-create endpoint is
 * rejected here too (and vice versa).
 */

// ── Header map (case-insensitive, trimmed) ────────────────────────────────────
const HEADER_MAP = {
  'project name':        'project_name',
  'name':                'project_name',
  'project':             'project_name',
  'project_name':        'project_name',
  'project code':        'project_code',
  'code':                'project_code',
  'project_code':        'project_code',
  'proj code':           'project_code',
  'proj_code':           'project_code',
  'client code':         'client_code',
  'client_code':         'client_code',
  'clt code':            'client_code',
  'clt_code':            'client_code',
  'client':              'client_name',
  'client name':         'client_name',
  'client_name':         'client_name',
  'customer':            'client_name',
  'customer name':       'client_name',
  'description':         'project_description',
  'project description': 'project_description',
  'project_description': 'project_description',
  'status':              'status',
};

function normaliseHeader(cell) {
  if (!cell) return null;
  return HEADER_MAP[String(cell).trim().toLowerCase()] || null;
}

/**
 * Find the header row by scanning the first 5 rows.
 * The row must contain at least one recognised column AND a project_name variant.
 */
function findHeaderRow(rows) {
  const nameVariants = new Set(['project name', 'name', 'project', 'project_name']);
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
 * Returns { errors[], projectName, projectCode, clientCode, clientName, description, status }.
 */
function validateRow(data) {
  const errors = [];

  const projectName = String(data.project_name || '').trim();
  if (!projectName) {
    errors.push('Project Name is required.');
  } else if (projectName.length < 2) {
    errors.push('Project Name must be at least 2 characters.');
  } else if (projectName.length > 200) {
    errors.push('Project Name must not exceed 200 characters.');
  }

  const projectCode = data.project_code ? String(data.project_code).trim().toUpperCase() : null;
  if (projectCode && !/^[A-Z0-9_-]{2,30}$/.test(projectCode)) {
    errors.push('Project Code must be 2-30 uppercase letters/digits (hyphens and underscores allowed).');
  }

  const clientCode = data.client_code ? String(data.client_code).trim().toUpperCase() : null;
  const clientName = data.client_name ? String(data.client_name).trim() : null;
  if (!clientCode && !clientName) {
    errors.push('Either Client Code or Client Name is required.');
  }

  const description = data.project_description ? String(data.project_description).trim() : null;
  if (description && description.length > 2000) {
    errors.push('Project Description must not exceed 2000 characters.');
  }

  const statusRaw = data.status ? String(data.status).trim().toLowerCase() : 'active';
  const status    = ['active', 'inactive'].includes(statusRaw) ? statusRaw : null;
  if (!status) {
    errors.push(`Status must be "active" or "inactive". Got: "${data.status}".`);
  }

  return { errors, projectName, projectCode, clientCode, clientName, description, status: status || 'active' };
}

/**
 * Parse an Excel/CSV file and bulk-import projects.
 *
 * Business Unit rule (identical to the single POST /projects endpoint):
 *  - A BU-scoped actor (BU Admin and below) always has every row created
 *    under THEIR OWN Business Unit — any company_id in the request body is
 *    ignored (resolveOptionalCreateCompanyId()).
 *  - A company-less actor (Admin/Entity Admin) may optionally pass a single
 *    `company_id` in the multipart form body to import the whole file into
 *    one of their own Business Units; if omitted, every row is created with
 *    no Business Unit assigned (company_id NULL), deferred exactly like a
 *    single Project create by the same actor.
 *
 * Client rule (identical to projectService.create()): each row's Client
 * (resolved by Client Code or Client Name) must be active, and must belong
 * to the resolved company_id (or, for a BU-less import, to one of the
 * actor's own owned Companies, or itself have no Business Unit).
 *
 * @param {string} filePath
 * @param {number} userId
 * @param {import('express').Request} req
 * @returns {Promise<{ total, imported, skipped, error_rows }>}
 */
async function importProjects(filePath, userId, req) {
  const bodyCompanyId = req.body && req.body.company_id ? parseInt(req.body.company_id, 10) : null;
  const companyId = await resolveCreateCompanyIdForActor(req, bodyCompanyId, { required: false });
  const authContext = { companyId: req.companyId, hierarchyRank: req.hierarchyRank, employeeId: req.employeeId };

  // Only needed for a company-less actor deferring BU assignment (companyId
  // null) — each row's Client may belong to any of this actor's own owned
  // Companies, resolved once up front rather than per row.
  const ownedCompanyIds = companyId == null
    ? ((await resolveOwnedCompanyIds(authContext.hierarchyRank, authContext.employeeId)) || [])
    : [];

  logger.info('Project import started', { userId, companyId, filePath });

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
        'Ensure the sheet has a column named "Project Name" (or "Name").'
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

  if (!('project_name' in fieldIndex)) {
    throw Object.assign(new Error('Missing required column "Project Name".'), { statusCode: 422 });
  }
  if (!('client_code' in fieldIndex) && !('client_name' in fieldIndex)) {
    throw Object.assign(
      new Error('Missing required column "Client Code" or "Client Name" — every Project must belong to a Client.'),
      { statusCode: 422 }
    );
  }

  // ── Pre-fetch existing projects for duplicate detection (scoped to this
  // company — uniqueness is per-company, not global; company_id: null is a
  // valid Sequelize equality filter for "no Business Unit") ────────────────
  const existingProjects = await Project.findAll({
    where: { company_id: companyId, is_deleted: false },
    attributes: ['project_name', 'project_code'],
    raw: true,
  });

  const existingNames = new Set(existingProjects.map((p) => p.project_name.trim().toLowerCase()));
  const existingCodes = new Set(existingProjects.map((p) => p.project_code.trim().toLowerCase()));

  // Within-file duplicate trackers
  const fileNames = new Set();
  const fileCodes = new Set();

  // Client lookups repeat across rows (many Projects share one Client) —
  // cache by the lookup key so we hit the DB once per distinct Client.
  const clientCache = new Map();

  // ── Process data rows ───────────────────────────────────────────────────────
  const dataRows = rawRows.slice(headerIndex + 1);
  const total    = dataRows.filter((r) => r.some((c) => c !== '' && c !== null && c !== undefined)).length;

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
      project_name:         getCell(row, 'project_name'),
      project_code:         getCell(row, 'project_code'),
      client_code:          getCell(row, 'client_code'),
      client_name:          getCell(row, 'client_name'),
      project_description:  getCell(row, 'project_description'),
      status:               getCell(row, 'status'),
    };

    const { errors, projectName, projectCode, clientCode, clientName, description, status } = validateRow(rawData);

    if (errors.length > 0) {
      error_rows.push({ row_number: rowNumber, row_data: rawData, errors });
      continue;
    }

    // ── Resolve the Client (by code first, else by name) ────────────────────
    const clientKey = `${clientCode || ''}|${(clientName || '').toLowerCase()}`;
    let client = clientCache.get(clientKey);
    if (client === undefined) {
      const where = clientCode
        ? { client_code: clientCode }
        : { client_name: { [Op.iLike]: clientName } };
      client = (await Client.findOne({ where })) || null;
      clientCache.set(clientKey, client);
    }

    if (!client) {
      error_rows.push({
        row_number: rowNumber,
        row_data:   rawData,
        errors:     [`Client "${clientCode || clientName}" not found.`],
      });
      continue;
    }

    // Same membership rule as projectService.create(): a BU-scoped actor's
    // Client must belong to that exact company; a company-less actor's
    // Client may belong to any of their own owned Companies, or have no
    // Business Unit at all.
    const clientInScope = companyId != null
      ? client.company_id === companyId
      : (client.company_id === null || ownedCompanyIds.includes(client.company_id));

    if (!clientInScope) {
      error_rows.push({
        row_number: rowNumber,
        row_data:   rawData,
        errors:     [`Client "${client.client_name}" is not accessible to you.`],
      });
      continue;
    }

    if (client.status !== 'active') {
      error_rows.push({
        row_number: rowNumber,
        row_data:   rawData,
        errors:     [`Cannot create a Project for inactive client "${client.client_name}".`],
      });
      continue;
    }

    // ── Duplicate checks ────────────────────────────────────────────────────
    if (fileNames.has(projectName.toLowerCase())) {
      skipped++;
      error_rows.push({
        row_number: rowNumber,
        row_data:   rawData,
        errors:     [`Duplicate project name "${projectName}" within the file.`],
        skipped:    true,
      });
      continue;
    }

    if (existingNames.has(projectName.toLowerCase())) {
      skipped++;
      error_rows.push({
        row_number: rowNumber,
        row_data:   rawData,
        errors:     [`Project "${projectName}" already exists.`],
        skipped:    true,
      });
      continue;
    }

    if (projectCode) {
      const codeLower = projectCode.toLowerCase();
      if (existingCodes.has(codeLower) || fileCodes.has(codeLower)) {
        skipped++;
        error_rows.push({
          row_number: rowNumber,
          row_data:   rawData,
          errors:     [`Project code "${projectCode}" is already in use.`],
          skipped:    true,
        });
        continue;
      }
    }

    // ── Auto-generate code if absent ────────────────────────────────────────
    let finalCode = projectCode;
    if (!finalCode) {
      let attempts = 0;
      do {
        finalCode = generateProjectCode();
        attempts++;
      } while (
        (existingCodes.has(finalCode.toLowerCase()) || fileCodes.has(finalCode.toLowerCase())) &&
        attempts < 10
      );

      if (existingCodes.has(finalCode.toLowerCase()) || fileCodes.has(finalCode.toLowerCase())) {
        error_rows.push({
          row_number: rowNumber,
          row_data:   rawData,
          errors:     ['Failed to generate a unique project code. Please try again.'],
        });
        continue;
      }
    }

    // ── Insert ───────────────────────────────────────────────────────────────
    try {
      await Project.create({
        project_name:         projectName,
        project_code:         finalCode,
        project_description:  description,
        client_id:            client.id,
        status,
        company_id:           companyId,
        created_by:           userId,
        updated_by:           userId,
      });

      // Register in in-memory sets so later rows in the same file detect dupes
      existingNames.add(projectName.toLowerCase());
      existingCodes.add(finalCode.toLowerCase());
      fileNames.add(projectName.toLowerCase());
      fileCodes.add(finalCode.toLowerCase());

      imported++;
    } catch (err) {
      logger.error('Project import row insert failed', { rowNumber, error: err.message });
      error_rows.push({
        row_number: rowNumber,
        row_data:   rawData,
        errors:     [`Database error: ${err.message}`],
      });
    }
  }

  logger.info('Project import completed', {
    userId,
    total,
    imported,
    skipped,
    errors: error_rows.length - skipped,
  });

  return { total, imported, skipped, error_rows };
}

module.exports = { importProjects };
