'use strict';

const platformAdminService = require('../services/platformAdminService');
const { toMultiSheetExcelBuffer } = require('../utils/reportExporter');
const { sendSuccess, sendPaginated, sendError } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * Platform Admin Controller — Platform-level only, gated by
 * requirePlatformAdmin (see platformAdmin.routes.js).
 */

const getOrganizationOverview = async (req, res, next) => {
  try {
    const data = await platformAdminService.getOrganizationOverview();
    return sendSuccess(res, data, 'Platform organization overview fetched successfully.');
  } catch (err) {
    logger.error('platformAdmin getOrganizationOverview error', { error: err.message, userId: req.userId });
    next(err);
  }
};

/**
 * GET /platform-admin/total-admins — "Total Admins" tab.
 */
const getTotalAdmins = async (req, res, next) => {
  try {
    const { data, meta } = await platformAdminService.getTotalAdmins(req.query);
    return sendPaginated(res, data, meta, 'Total Admins fetched successfully.');
  } catch (err) {
    if (err.statusCode) return sendError(res, err.message, err.statusCode);
    logger.error('platformAdmin getTotalAdmins error', { error: err.message, userId: req.userId });
    next(err);
  }
};

/**
 * GET /platform-admin/employee-work-log-synced — "Employee Work Log" tab.
 */
const getEmployeeWorkLogSynced = async (req, res, next) => {
  try {
    const result = await platformAdminService.getEmployeeWorkLogSynced(req.query);
    return sendPaginated(
      res,
      { period: result.period, records: result.data },
      result.meta,
      'Employee Work Log (synced) fetched successfully.'
    );
  } catch (err) {
    if (err.statusCode) return sendError(res, err.message, err.statusCode);
    logger.error('platformAdmin getEmployeeWorkLogSynced error', { error: err.message, userId: req.userId });
    next(err);
  }
};

/**
 * GET /platform-admin/employee-work-log-synced/export?month=&year=
 * One workbook, 2 sheets ("Hours > 0" / "Hours = 0") — see
 * platformAdminService.exportEmployeeWorkLogSynced.
 */
const exportEmployeeWorkLogSynced = async (req, res) => {
  try {
    const { month, year } = req.query;
    const { sheets } = await platformAdminService.exportEmployeeWorkLogSynced(req.query);
    const buffer = await toMultiSheetExcelBuffer(sheets);
    const filename = `Employee_Work_Log_Synced_${year}-${String(month).padStart(2, '0')}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(buffer);
  } catch (err) {
    logger.error('platformAdmin exportEmployeeWorkLogSynced error', { error: err.message, userId: req.userId });
    return sendError(res, err.message, err.statusCode || 500);
  }
};

module.exports = {
  getOrganizationOverview,
  getTotalAdmins,
  getEmployeeWorkLogSynced,
  exportEmployeeWorkLogSynced,
};
