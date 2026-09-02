'use strict';

const tenantExportService = require('../services/tenantExportService');
const { toMultiSheetExcelBuffer } = require('../utils/reportExporter');
const { sendError } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * GET /api/v1/reports/tenant-data-export?month=8&year=2026
 * Admin / Entity Admin only (requireEntityAdminOrAdmin). One workbook, 5
 * sheets — see tenantExportService.buildExport's doc comment.
 */
const exportTenantData = async (req, res) => {
  try {
    const month = parseInt(req.query.month, 10);
    const year = parseInt(req.query.year, 10);

    const { sheets } = await tenantExportService.buildExport(
      {
        hierarchyRank: req.hierarchyRank,
        employeeId: req.employeeId,
        userId: req.userId,
        roleNames: req.userRoles,
      },
      { month, year }
    );

    const buffer = await toMultiSheetExcelBuffer(sheets);
    const filename = `Tenant_Data_Export_${year}-${String(month).padStart(2, '0')}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(buffer);
  } catch (error) {
    logger.error('exportTenantData error', { error: error.message, userId: req.userId });
    return sendError(res, error.message, error.statusCode || 500);
  }
};

module.exports = { exportTenantData };
