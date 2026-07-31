'use strict';

const timesheetService = require('../services/timesheetService');
const { createAuditLog, getIpAddress } = require('../middlewares/auditLog');
const {
  sendSuccess,
  sendCreated,
  sendNoContent,
  sendPaginated,
  sendNotFound,
  sendError,
} = require('../utils/response');
const logger = require('../utils/logger');

// ── Helper: standardise error handling across handlers ───────────────────────
function handleError(next, err, context) {
  logger.error(`TimesheetController error [${context}]`, {
    message: err.message,
    stack: err.stack,
  });
  // Surface known HTTP errors; delegate the rest to the global handler
  if (err.statusCode) {
    err.status = err.statusCode;
  }
  next(err);
}

// ── Import Handlers ───────────────────────────────────────────────────────────

/**
 * POST /api/v1/timesheets/upload
 *
 * Accepts a multipart file upload (field: "file"), parses and validates
 * all rows, persists an import history record, and returns a preview
 * of valid and error rows.
 *
 * The file is already on disk courtesy of the handleTimesheetUpload middleware.
 */
const upload = async (req, res, next) => {
  try {
    const { path: filePath, originalname, mimetype } = req.file;
    const userId = req.userId;

    const month = parseInt(req.body.month, 10);
    const year  = parseInt(req.body.year,  10);

    if (!month || month < 1 || month > 12) {
      return sendError(res, 'month is required and must be between 1 and 12.', 422);
    }
    if (!year || year < 2000) {
      return sendError(res, 'year is required and must be 2000 or later.', 422);
    }

    const result = await timesheetService.previewImport(
      filePath,
      originalname,
      userId,
      mimetype,
      month,
      year,
      req.companyId
    );

    return sendSuccess(
      res,
      result,
      result.canConfirm
        ? `Preview ready. ${result.validRows} valid row(s), ${result.errorRows} error(s). Call POST /confirm/${result.importId} to import.`
        : `No valid rows found. ${result.errorRows} error(s). Please correct the file and re-upload.`,
      200
    );
  } catch (err) {
    return handleError(next, err, 'upload');
  }
};

/**
 * POST /api/v1/timesheets/sync-employee-worklogs
 *
 * "Sync Employee Work Logs" — an alternative source to the Excel upload
 * above. Reads every 'pending' row from the employee_work_logs table
 * (Employee Self Timesheet module, Stage 1 — never from `timesheets`) for
 * the selected month/year and runs them through the EXACT SAME preview
 * pipeline (validation, 176-hour adjustment, duplicate detection, import
 * history) as an Excel upload. The returned importId is confirmed with the
 * SAME POST /timesheets/confirm/:importId endpoint used for Excel imports.
 */
const syncEmployeeWorkLogs = async (req, res, next) => {
  try {
    const userId = req.userId;
    const month = parseInt(req.body.month, 10);
    const year  = parseInt(req.body.year,  10);

    if (!month || month < 1 || month > 12) {
      return sendError(res, 'month is required and must be between 1 and 12.', 422);
    }
    if (!year || year < 2000) {
      return sendError(res, 'year is required and must be 2000 or later.', 422);
    }

    const result = await timesheetService.previewPmsImport(month, year, userId, req.companyId);

    return sendSuccess(
      res,
      result,
      result.canConfirm
        ? `Sync preview ready. ${result.validRows} valid row(s), ${result.errorRows} error(s). Call POST /confirm/${result.importId} to import.`
        : `No pending employee work log entries found for this month. ${result.errorRows} error(s).`,
      200
    );
  } catch (err) {
    return handleError(next, err, 'syncEmployeeWorkLogs');
  }
};

/**
 * POST /api/v1/timesheets/confirm/:importId
 *
 * Confirms a pending import: re-validates the source file and bulk-inserts
 * all valid rows into the timesheets table.
 */
const confirm = async (req, res, next) => {
  try {
    const importId = parseInt(req.params.importId, 10);
    if (isNaN(importId) || importId < 1) {
      return sendError(res, 'Invalid importId parameter.', 400);
    }

    const result = await timesheetService.confirmImport(
      importId,
      req.userId,
      getIpAddress(req),
      req.companyId
    );

    return sendSuccess(
      res,
      result,
      `Import #${importId} completed. ${result.insertedRows} timesheet row(s) inserted.`,
      200
    );
  } catch (err) {
    return handleError(next, err, 'confirm');
  }
};

/**
 * GET /api/v1/timesheets/import/history
 *
 * Returns a paginated list of all past import operations.
 */
const getHistory = async (req, res, next) => {
  try {
    const { data, meta } = await timesheetService.getImportHistory(req.query, req.companyId);
    return sendPaginated(res, data, meta, 'Import history fetched successfully.');
  } catch (err) {
    return handleError(next, err, 'getHistory');
  }
};

/**
 * GET /api/v1/timesheets/import/:id
 *
 * Returns a single import history record, including all error rows.
 */
const getImportById = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid import ID.', 400);
    }

    const record = await timesheetService.getImportById(id, req.companyId);
    return sendSuccess(res, record, 'Import record fetched successfully.');
  } catch (err) {
    return handleError(next, err, 'getImportById');
  }
};

/**
 * GET /api/v1/timesheets/import/:id/rows
 *
 * Returns all timesheet rows inserted as part of the given import.
 *
 * `role` (from body/query, merged — NOT the JWT, see hoursVisibility.js)
 * controls whether rows show the original hours_logged + modified_hours
 * side by side, or (role === "management") only the effective/modified
 * value under hours_logged.
 */
const getImportRows = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid import ID.', 400);
    }
    const filters = { ...req.body, ...req.query };

    const rows = await timesheetService.getImportRows(id, filters.role, req.companyId);
    return sendSuccess(res, rows, 'Imported timesheet rows fetched successfully.');
  } catch (err) {
    return handleError(next, err, 'getImportRows');
  }
};

// ── CRUD Handlers ─────────────────────────────────────────────────────────────

/**
 * GET /api/v1/timesheets
 *
 * Query params: page, limit, startDate, endDate, employeeId, poId, subProjectId,
 *               sortBy, sortOrder, role
 *
 * `role` (from body/query, merged — NOT the JWT, see hoursVisibility.js)
 * controls whether rows show the original hours_logged + modified_hours
 * side by side, or (role === "management") only the effective/modified
 * value under hours_logged.
 */
const getAll = async (req, res, next) => {
  try {
    const filters = { ...req.body, ...req.query };
    const { data, meta } = await timesheetService.getAllTimesheets(filters, req.companyId);
    return sendPaginated(res, data, meta, 'Timesheets fetched successfully.');
  } catch (err) {
    return handleError(next, err, 'getAll');
  }
};

/**
 * GET /api/v1/timesheets/:id
 *
 * `role` (from body/query, merged — NOT the JWT, see hoursVisibility.js)
 * controls whether the response shows the original hours_logged +
 * modified_hours side by side, or (role === "management") only the
 * effective/modified value under hours_logged.
 */
const getById = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid timesheet ID.', 400);
    }
    const filters = { ...req.body, ...req.query };

    const record = await timesheetService.getTimesheetById(id, filters.role, req.companyId);
    return sendSuccess(res, record, 'Timesheet fetched successfully.');
  } catch (err) {
    return handleError(next, err, 'getById');
  }
};

/**
 * POST /api/v1/timesheets
 *
 * Manual single-entry create — e.g. an Admin backfilling a row missing from
 * an Excel upload. Resolves and validates employee/PO/sub-project exactly as
 * the Excel import does; client_id/service_type_id/service_category_id are
 * optional extra cross-checks (validation-only, never stored on the row).
 * timesheet_import_id is required — the entry is attached to that monthly
 * sheet, and the employee's hours within it must not exceed 176.
 *
 * Body: { employee_id, service_po_id, sub_project_id?, timesheet_import_id, client_id?, service_type_id?, service_category_id?, timesheet_date, hours_logged }
 */
const create = async (req, res, next) => {
  try {
    const data = {
      employee_id:          req.body.employee_id,
      service_po_id:        req.body.service_po_id,
      sub_project_id:       req.body.sub_project_id || null,
      timesheet_import_id:  req.body.timesheet_import_id,
      client_id:            req.body.client_id,
      service_type_id:      req.body.service_type_id,
      service_category_id:  req.body.service_category_id,
      timesheet_date:       req.body.timesheet_date,
      hours_logged:         req.body.hours_logged,
      created_by:           req.userId,
      updated_by:           req.userId,
    };

    const timesheet = await timesheetService.createTimesheet(data, req.companyId);

    createAuditLog(
      req.userId,
      'CREATE',
      'timesheets',
      timesheet.id,
      null,
      timesheet.toJSON(),
      getIpAddress(req)
    );

    return sendCreated(res, { id: timesheet.id }, 'Timesheet entry created successfully.');
  } catch (err) {
    return handleError(next, err, 'create');
  }
};

/**
 * PUT /api/v1/timesheets/:id
 *
 * Body: partial timesheet fields
 */
const update = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid timesheet ID.', 400);
    }

    const data = {
      ...(req.body.employee_id   !== undefined && { employee_id:   req.body.employee_id }),
      ...(req.body.service_po_id !== undefined && { service_po_id: req.body.service_po_id }),
      ...(req.body.sub_project_id !== undefined && { sub_project_id: req.body.sub_project_id }),
      ...(req.body.timesheet_date !== undefined && { timesheet_date: req.body.timesheet_date }),
      ...(req.body.hours_logged   !== undefined && { hours_logged:   req.body.hours_logged }),
      updated_by: req.userId,
    };

    const timesheet = await timesheetService.updateTimesheet(id, data, req.companyId);

    createAuditLog(
      req.userId,
      'UPDATE',
      'timesheets',
      id,
      null,
      timesheet.toJSON(),
      getIpAddress(req)
    );

    return sendSuccess(res, timesheet, 'Timesheet entry updated successfully.');
  } catch (err) {
    return handleError(next, err, 'update');
  }
};

/**
 * PATCH /api/v1/timesheets/:id/modified-hours
 *
 * HR-only. Sets the admin-adjustable "Modified Hours" for a single
 * timesheet entry, and marks it (and its parent monthly sheet, if any) as
 * published (is_publish = true). Never touches hours_logged, the original
 * immutable value — a separate endpoint from PUT /timesheets/:id, which
 * never touches modified_hours/is_publish.
 *
 * Body: { modified_hours }
 */
const updateModifiedHours = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid timesheet ID.', 400);
    }

    const timesheet = await timesheetService.updateModifiedHours(id, req.body.modified_hours, req.companyId);

    createAuditLog(
      req.userId,
      'UPDATE',
      'timesheets',
      id,
      null,
      { modified_hours: timesheet.modified_hours, is_publish: timesheet.is_publish },
      getIpAddress(req)
    );

    return sendSuccess(res, timesheet, 'Modified hours updated successfully.');
  } catch (err) {
    return handleError(next, err, 'updateModifiedHours');
  }
};

/**
 * PUT /api/v1/timesheets/import/:timesheetImportId/hours
 *
 * HR-only. Bulk-updates modified_hours for several timesheet entries
 * belonging to ONE monthly import. Never touches is_publish — a dedicated,
 * narrower sibling of PATCH /:id/modified-hours; publishing is a separate
 * endpoint (see publishImport below).
 *
 * Body: { timesheets: [{ id, hours }, ...] }
 */
const bulkUpdateImportHours = async (req, res, next) => {
  try {
    const timesheetImportId = parseInt(req.params.timesheetImportId, 10);
    if (isNaN(timesheetImportId) || timesheetImportId < 1) {
      return sendError(res, 'Invalid timesheet import ID.', 400);
    }

    const { timesheets } = req.body;

    const updatedCount = await timesheetService.bulkUpdateImportModifiedHours(timesheetImportId, timesheets, req.companyId);

    createAuditLog(
      req.userId,
      'UPDATE',
      'timesheets',
      null,
      null,
      { timesheetImportId, updatedIds: timesheets.map((t) => t.id), updatedCount },
      getIpAddress(req)
    );

    return sendSuccess(
      res,
      { updated_records: updatedCount },
      'Timesheet hours updated successfully.'
    );
  } catch (err) {
    return handleError(next, err, 'bulkUpdateImportHours');
  }
};

/**
 * PUT /api/v1/timesheets/import/:timesheetImportId/publish
 *
 * HR-only. Publishes an imported monthly sheet: sets is_publish = true on
 * the timesheet_import_history record and every timesheets row belonging to
 * it. Never touches hours_logged/modified_hours — a dedicated, narrower
 * sibling of PUT /import/:timesheetImportId/hours above. is_publish is a
 * one-way flag; publishing an already-published import is a no-op that
 * reports it back instead of writing again.
 *
 * No request body.
 */
const publishImport = async (req, res, next) => {
  try {
    const timesheetImportId = parseInt(req.params.timesheetImportId, 10);
    if (isNaN(timesheetImportId) || timesheetImportId < 1) {
      return sendError(res, 'Invalid timesheet import ID.', 400);
    }

    const { alreadyPublished } = await timesheetService.publishImport(timesheetImportId, req.companyId);

    if (alreadyPublished) {
      return sendSuccess(res, { timesheetImportId }, 'Monthly timesheet is already published.');
    }

    createAuditLog(
      req.userId,
      'UPDATE',
      'timesheet_import_history',
      timesheetImportId,
      null,
      { is_publish: true },
      getIpAddress(req)
    );

    return sendSuccess(res, { timesheetImportId }, 'Monthly timesheet published successfully.');
  } catch (err) {
    return handleError(next, err, 'publishImport');
  }
};

/**
 * DELETE /api/v1/timesheets/:id
 */
const deleteTimesheet = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid timesheet ID.', 400);
    }

    await timesheetService.deleteTimesheet(id, req.companyId);

    createAuditLog(
      req.userId,
      'DELETE',
      'timesheets',
      id,
      null,
      null,
      getIpAddress(req)
    );

    return sendNoContent(res);
  } catch (err) {
    return handleError(next, err, 'deleteTimesheet');
  }
};

/**
 * Normalises a request body's `ids` field into a clean array of positive
 * integers. Accepts { ids: [1,2,3] }, { ids: 5 }, or { id: 5 } so the same
 * endpoint naturally supports both single-row and multi-row deletes.
 *
 * @param {object} body - req.body
 * @returns {number[]}
 */
function parseIdsFromBody(body) {
  let ids = body && body.ids !== undefined ? body.ids : undefined;
  if (!Array.isArray(ids)) {
    ids = ids !== undefined ? [ids] : (body && body.id !== undefined ? [body.id] : []);
  }
  return ids
    .map((v) => parseInt(v, 10))
    .filter((v) => !isNaN(v) && v > 0);
}

/**
 * DELETE /api/v1/timesheets
 * DELETE /api/v1/timesheets/import
 *
 * Deletes one or more "monthly sheets" (timesheet import batches) in a single call.
 * Body: { ids: [1, 2, 3] } — pass a single-element array to delete just one sheet.
 * Each id is a Timesheet Import History ID (timesheet_import_history.id).
 *
 * For every import this removes the child timesheet rows created by that import,
 * the child error rows, the import history record itself, and the uploaded file
 * on disk.
 */
const deleteImports = async (req, res, next) => {
  try {
    const ids = parseIdsFromBody(req.body);

    if (ids.length === 0) {
      return sendError(res, 'ids must be a non-empty array of valid Timesheet Import History IDs.', 422);
    }

    const result = await timesheetService.deleteImports(ids, req.companyId);

    createAuditLog(
      req.userId,
      'DELETE',
      'timesheet_import_history',
      null,
      null,
      { deletedIds: ids, ...result },
      getIpAddress(req)
    );

    return sendSuccess(
      res,
      result,
      `${result.deletedImportCount} monthly sheet(s) deleted, along with ${result.deletedTimesheetRows} timesheet row(s) and ${result.deletedErrorRows} error row(s).`,
      200
    );
  } catch (err) {
    return handleError(next, err, 'deleteImports');
  }
};

module.exports = {
  upload,
  syncEmployeeWorkLogs,
  confirm,
  getHistory,
  getImportById,
  getImportRows,
  getAll,
  getById,
  create,
  update,
  updateModifiedHours,
  bulkUpdateImportHours,
  publishImport,
  deleteTimesheet,
  deleteImports,
};