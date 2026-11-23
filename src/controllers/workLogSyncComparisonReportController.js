'use strict';

const service = require('../services/workLogSyncComparisonReportService');
const { sendPaginated, sendSuccess, sendError } = require('../utils/response');
const logger = require('../utils/logger');
const { toMultiSheetExcelBuffer, toCsvExportBuffer } = require('../utils/reportExporter');

const authContextOf = (req) => ({
  userId: req.userId,
  employeeId: req.employeeId,
  hierarchyRank: req.hierarchyRank,
  roleNames: req.userRoles,
});

function periodLabel(period) {
  if (period.type === 'month') return `${period.year}-${String(period.month).padStart(2, '0')}`;
  if (period.type === 'date') return period.date;
  return `${period.start_date} to ${period.end_date}`;
}

function fail(res, next, name, err) {
  if (err.statusCode) return sendError(res, err.message, err.statusCode);
  logger.error(`${name} error`, { error: err.message, stack: err.stack });
  return next(err);
}

/**
 * GET /api/v1/reports/work-log-sync-comparison
 * format=json (paged: period, totals, records) | excel | csv (every row of the same filtered set).
 */
async function getWorkLogSyncComparisonReport(req, res, next) {
  try {
    const format = req.query.format || 'json';
    if (format === 'json') {
      const result = await service.getReport(req.query, authContextOf(req), req.companyIds);
      return sendPaginated(
        res,
        { period: result.period, totals: result.totals, records: result.records },
        result.meta,
        'Work log sync comparison report fetched successfully.'
      );
    }

    const { period, columns, rows } = await service.getExport(req.query, authContextOf(req), req.companyIds);
    const isExcel = format === 'excel';
    const buffer = isExcel
      ? await toMultiSheetExcelBuffer([{ name: 'Work Log Sync Comparison', columns, rows }])
      : toCsvExportBuffer(rows, columns);
    res.setHeader('Content-Type', isExcel ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="Work Log Sync Comparison ${periodLabel(period)}.${isExcel ? 'xlsx' : 'csv'}"`);
    return res.send(Buffer.from(buffer));
  } catch (err) {
    return fail(res, next, 'getWorkLogSyncComparisonReport', err);
  }
}

/** GET /api/v1/reports/work-log-sync-comparison/filter-options */
async function getWorkLogSyncComparisonFilterOptions(req, res, next) {
  try {
    const options = await service.getFilterOptions(req.query, authContextOf(req), req.companyIds);
    return sendSuccess(res, options, 'Filter options fetched successfully.');
  } catch (err) {
    return fail(res, next, 'getWorkLogSyncComparisonFilterOptions', err);
  }
}

module.exports = { getWorkLogSyncComparisonReport, getWorkLogSyncComparisonFilterOptions };
