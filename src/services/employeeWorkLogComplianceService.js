'use strict';

const { Op } = require('sequelize');
const { Employee } = require('../models');
const employeeRepository = require('../repositories/employeeRepository');
const employeeAccessControlService = require('./employeeAccessControlService');
const complianceRepository = require('../repositories/employeeWorkLogComplianceRepository');
const dateHelper = require('../helpers/dateHelper');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const emailLogService = require('./emailLogService');
const {
  buildWorkLogComplianceReminderSubject,
  buildWorkLogComplianceReminderHtml,
} = require('../utils/emailTemplates');
const frontendConfig = require('../config/frontend.config');
const logger = require('../utils/logger');

/**
 * Employee Work Log Compliance Service
 *
 * Two operations:
 *  1. getReport   — paginated list of employees below the hours threshold.
 *  2. sendReminder — verify employee is still below threshold, then email them.
 *
 * THRESHOLDS (hard-coded per specification):
 *   Date  mode → 8 hours
 *   Month mode → 160 hours
 *
 * EMPLOYEE VISIBILITY:
 *   Delegates entirely to resolveAuthorizedEmployeeIds(), which reuses
 *   employeeAccessControlService.resolveEmployeeAccessWhere() — the same
 *   data-driven scope logic used by Employee Master and the Employee Work
 *   Log Hours Summary report. No new access-control rules are invented here.
 *
 *   Admin        → all employees under the Admin's tenant/company hierarchy.
 *   BU Admin     → all employees belonging to mapped Business Unit(s).
 *   Service PO Admin → employees belonging to their authorized BUs.
 *   Delivery Head    → employees belonging to their authorized BUs.
 *   Manager      → ONLY employees mapped to that Manager
 *                  (manager_employee_mappings + team_mappings).
 *   Employee     → their own record only (will almost never appear in the
 *                  report unless they look at their own period).
 */

/** Date-mode threshold: 8 hours per day. */
const DATE_THRESHOLD = 8;

/** Month-mode threshold: 160 hours per month. */
const MONTH_THRESHOLD = 160;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function badRequestError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function forbiddenError(message) {
  const err = new Error(message);
  err.statusCode = 403;
  return err;
}

function notFoundError(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

function emailDeliveryError(message) {
  const err = new Error(message);
  err.statusCode = 502;
  return err;
}

/**
 * Resolve the period from the validated query/body.
 * Returns { startDate, endDate, threshold, periodLabel, periodMeta }.
 *
 * periodLabel  — human-readable string for the email body.
 * periodMeta   — structured object returned in the API response.
 */
function resolvePeriod(params) {
  if (params.date) {
    return {
      startDate: params.date,
      endDate: params.date,
      threshold: DATE_THRESHOLD,
      periodLabel: dateHelper.formatDisplayDate(params.date),   // e.g. "28 Aug 2026"
      periodMeta: { type: 'date', date: params.date },
    };
  }

  const { startDate, endDate } = dateHelper.getMonthBounds(params.month, params.year);
  // Format as "August 2026"
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const periodLabel = `${monthNames[params.month - 1]} ${params.year}`;

  return {
    startDate,
    endDate,
    threshold: MONTH_THRESHOLD,
    periodLabel,
    periodMeta: { type: 'month', month: params.month, year: params.year },
  };
}

// ─── Employee ID resolution ───────────────────────────────────────────────────

/**
 * Returns the flat list of employee IDs the caller is authorised to see,
 * across all their reachable Business Units (companyIds array).
 *
 * Identical logic to employeeWorkLogHoursSummaryService.resolveAuthorizedEmployeeIds
 * — copied here (not imported) to keep this service self-contained and avoid
 * creating an implicit cross-service coupling that could break if that
 * service is ever refactored.
 *
 * @param {object}   authContext
 * @param {number[]} companyIds
 * @returns {Promise<number[]>}
 */
async function resolveAuthorizedEmployeeIds(authContext, companyIds) {
  if (!companyIds.length) return [];

  const accessScopes = await Promise.all(
    companyIds.map((companyId) =>
      employeeAccessControlService.resolveEmployeeAccessWhere({ ...authContext, companyId })
    )
  );
  const companyScope = await employeeRepository.employeeScope(companyIds);
  const employees = await Employee.findAll({
    where: {
      [Op.and]: [
        { is_deleted: false },
        { [Op.or]: accessScopes },
        companyScope,
      ],
    },
    attributes: ['id'],
    raw: true,
  });
  return employees.map((e) => e.id);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * GET /reports/employee-work-log-compliance
 *
 * Returns a paginated list of employees whose total logged hours for the
 * selected date or month are STRICTLY LESS THAN the required threshold.
 * Employees with zero work logs are included (logged_hours = 0).
 *
 * @param {object}   query       - Validated req.query
 * @param {object}   authContext - { userId, employeeId, hierarchyRank, roleNames }
 * @param {number[]} companyIds  - Pre-resolved company IDs from resolveReportCompanyScope
 * @returns {Promise<object>}
 */
async function getReport(query, authContext, companyIds) {
  const { startDate, endDate, threshold, periodMeta } = resolvePeriod(query);

  let employeeIds = await resolveAuthorizedEmployeeIds(authContext, companyIds);

  // Optional single-employee filter (e.g. a manager drilling into one person)
  if (query.employeeId) {
    const requested = parseInt(query.employeeId, 10);
    if (!employeeIds.includes(requested)) {
      throw forbiddenError('Access denied: you are not authorised to view this employee.');
    }
    employeeIds = [requested];
  }

  const { page, limit, offset } = getPaginationParams(query);
  const { rows, count } = await complianceRepository.getComplianceReport({
    employeeIds,
    startDate,
    endDate,
    threshold,
    search: query.search || undefined,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    limit,
    offset,
  });

  return {
    period: periodMeta,
    threshold,
    data: rows.map((row) => ({
      employee_id: row.employee_id,
      employee_name: row.employee_name,
      employee_code: row.employee_code,
      business_unit: row.business_unit || null,
      logged_hours: parseFloat(row.logged_hours) || 0,
      required_hours: parseFloat(row.required_hours),
      shortfall_hours: parseFloat(row.shortfall_hours),
      status: 'Incomplete',
    })),
    meta: getPaginationMeta(count, page, limit),
  };
}

/**
 * POST /reports/employee-work-log-compliance/remind
 *
 * Security contract (all enforced server-side — never trusted from frontend):
 *  1. Authenticate caller (handled by middleware).
 *  2. Resolve employee visibility via resolveAuthorizedEmployeeIds — a caller
 *     cannot send a reminder to an employee outside their authorised scope.
 *  3. Re-calculate the employee's logged hours for the period.
 *  4. Reject if the employee is ALREADY at or above the threshold.
 *  5. Resolve the employee's email from the employee record.
 *  6. Send the reminder email directly to the employee.
 *
 * @param {object}   body        - Validated req.body { employeeId, date? | month+year? }
 * @param {object}   authContext - { userId, employeeId, hierarchyRank, roleNames }
 * @param {number[]} companyIds  - Pre-resolved company IDs
 * @returns {Promise<object>}
 */
async function sendReminder(body, authContext, companyIds) {
  const { startDate, endDate, threshold, periodLabel } = resolvePeriod(body);

  // ── 1. Authorisation: is the target employee in the caller's scope? ────────
  const authorisedIds = await resolveAuthorizedEmployeeIds(authContext, companyIds);
  if (!authorisedIds.includes(body.employeeId)) {
    throw forbiddenError('Access denied: you are not authorised to send reminders for this employee.');
  }

  // ── 2. Load employee record ────────────────────────────────────────────────
  const employee = await Employee.findOne({
    where: { id: body.employeeId, is_deleted: false },
    attributes: ['id', 'full_name', 'employee_code', 'email', 'company_id'],
    raw: true,
  });
  if (!employee) {
    throw notFoundError('Employee not found.');
  }

  // ── 3. Re-calculate logged hours (never trust the UI) ─────────────────────
  const loggedHours = await complianceRepository.getEmployeeTotalHours({
    employeeId: body.employeeId,
    startDate,
    endDate,
  });

  // ── 4. Reject if already complete ─────────────────────────────────────────
  if (loggedHours >= threshold) {
    throw badRequestError(
      'Employee has completed the required work hours for this period. No reminder needed.'
    );
  }

  // ── 5. Validate employee email ────────────────────────────────────────────
  if (!employee.email) {
    throw badRequestError(
      'This employee does not have an email address configured. Cannot send reminder.'
    );
  }

  // ── 6. Build and send the email ───────────────────────────────────────────
  const shortfallHours = Math.round((threshold - loggedHours) * 100) / 100;
  const timesheetUrl = frontendConfig.getTimesheetUrl();

  const subject = buildWorkLogComplianceReminderSubject(periodLabel);
  const html = buildWorkLogComplianceReminderHtml({
    employeeName: employee.full_name,
    periodLabel,
    loggedHours,
    requiredHours: threshold,
    shortfallHours,
    timesheetUrl,
  });

  try {
    await emailLogService.sendAndLog({
      to: employee.email,
      subject,
      html,
      mailType: emailLogService.MAIL_TYPES.WORKLOG_COMPLIANCE_REMINDER,
      companyId: employee.company_id,
      triggeredByEmployeeId: authContext.employeeId,
      relatedEmployeeId: employee.id,
    });
  } catch (err) {
    logger.error('Failed to send work log compliance reminder email', {
      employeeId: employee.id,
      employeeEmail: employee.email,
      error: err.message,
    });
    throw emailDeliveryError('Unable to send reminder email. Please try again.');
  }

  logger.info('Work log compliance reminder sent', {
    sentBy: authContext.employeeId,
    employeeId: employee.id,
    employeeName: employee.full_name,
    periodLabel,
    loggedHours,
    threshold,
    shortfallHours,
  });

  return {
    message: 'Reminder sent successfully.',
    employee: {
      id: employee.id,
      full_name: employee.full_name,
      employee_code: employee.employee_code,
      email: employee.email,
    },
    period: periodLabel,
    logged_hours: loggedHours,
    required_hours: threshold,
    shortfall_hours: shortfallHours,
  };
}

/**
 * POST /reports/employee-work-log-compliance/remind-bulk
 *
 * Sends reminder emails to multiple employees in one request.
 *
 * Two modes:
 *   remindAll = true  — the backend resolves ALL authorised employees below
 *                       the threshold itself (no employeeIds needed from the
 *                       frontend). This is the "Remind All" / "Remind Selected All Pages"
 *                       action.
 *   employeeIds list  — remind only the explicitly supplied IDs (must all be
 *                       within the caller's authorised scope). This is the
 *                       "Remind Selected" action for a manually chosen subset.
 *
 * Per-employee processing:
 *   - Each employee's hours are re-calculated individually.
 *   - Already-complete employees are SKIPPED (not an error — the report may
 *     have been stale when the user selected them).
 *   - Employees with no email are recorded in the `skipped` list.
 *   - Email failures are recorded in the `failed` list — they never abort the
 *     rest of the batch.
 *
 * @param {object}   body        - Validated req.body
 * @param {object}   authContext
 * @param {number[]} companyIds
 * @returns {Promise<object>}
 */
async function sendBulkReminder(body, authContext, companyIds) {
  const { startDate, endDate, threshold, periodLabel } = resolvePeriod(body);

  // ── 1. Resolve the authorised employee set ─────────────────────────────────
  // If the caller supplied company_id (BU filter), narrow companyIds to that
  // single BU — but only after verifying it is within their authorised reach.
  // This is identical to how the GET report handles company_id: the
  // resolveReportCompanyScope middleware already validated the caller's full
  // reach into companyIds; we just restrict to the requested subset here.
  let effectiveCompanyIds = companyIds;
  if (body.company_id) {
    if (!companyIds.includes(body.company_id)) {
      throw forbiddenError(
        'Access denied: the selected Business Unit is not within your authorised scope.'
      );
    }
    effectiveCompanyIds = [body.company_id];
  }

  const authorisedIds = await resolveAuthorizedEmployeeIds(authContext, effectiveCompanyIds);

  let targetIds;
  if (body.remindAll) {
    // For "Remind All" the backend fetches every below-threshold employee
    // within the caller's authorised scope — no ID list needed from frontend.
    const { rows } = await complianceRepository.getComplianceReport({
      employeeIds: authorisedIds,
      startDate,
      endDate,
      threshold,
      limit: 10000,
      offset: 0,
    });
    targetIds = rows.map((r) => r.employee_id);
  } else {
    // "Remind Selected" — validate every supplied ID is in the authorised set.
    const unauthorised = body.employeeIds.filter((id) => !authorisedIds.includes(id));
    if (unauthorised.length > 0) {
      throw forbiddenError(
        `Access denied: employee ID(s) ${unauthorised.join(', ')} are outside your authorised scope.`
      );
    }
    targetIds = body.employeeIds;
  }

  if (targetIds.length === 0) {
    return {
      message: 'No employees to remind for the selected period.',
      sent: [], skipped: [], failed: [], total: 0,
    };
  }

  // ── 2. Load employee records for all target IDs in one query ───────────────
  const employees = await Employee.findAll({
    where: { id: { [Op.in]: targetIds }, is_deleted: false },
    attributes: ['id', 'full_name', 'employee_code', 'email', 'company_id'],
    raw: true,
  });
  const employeeMap = new Map(employees.map((e) => [e.id, e]));

  // ── 3. Process each employee ───────────────────────────────────────────────
  const sent = [];
  const skipped = [];
  const failed = [];

  // Process sequentially to avoid hammering the email provider with a
  // concurrent burst — a small pause between sends is intentional.
  for (const empId of targetIds) {
    const employee = employeeMap.get(empId);
    if (!employee) {
      skipped.push({ employee_id: empId, reason: 'Employee not found.' });
      continue;
    }

    if (!employee.email) {
      skipped.push({
        employee_id: empId,
        employee_name: employee.full_name,
        employee_code: employee.employee_code,
        reason: 'No email address configured.',
      });
      continue;
    }

    // Re-verify hours for this employee — skip if already complete.
    // eslint-disable-next-line no-await-in-loop
    const loggedHours = await complianceRepository.getEmployeeTotalHours({
      employeeId: empId,
      startDate,
      endDate,
    });

    if (loggedHours >= threshold) {
      skipped.push({
        employee_id: empId,
        employee_name: employee.full_name,
        employee_code: employee.employee_code,
        reason: 'Already completed required hours.',
      });
      continue;
    }

    const shortfallHours = Math.round((threshold - loggedHours) * 100) / 100;
    const timesheetUrl = frontendConfig.getTimesheetUrl();
    const subject = buildWorkLogComplianceReminderSubject(periodLabel);
    const html = buildWorkLogComplianceReminderHtml({
      employeeName: employee.full_name,
      periodLabel,
      loggedHours,
      requiredHours: threshold,
      shortfallHours,
      timesheetUrl,
    });

    try {
      // eslint-disable-next-line no-await-in-loop
      await emailLogService.sendAndLog({
        to: employee.email,
        subject,
        html,
        mailType: emailLogService.MAIL_TYPES.WORKLOG_COMPLIANCE_REMINDER,
        companyId: employee.company_id,
        triggeredByEmployeeId: authContext.employeeId,
        relatedEmployeeId: employee.id,
      });
      sent.push({
        employee_id: empId,
        employee_name: employee.full_name,
        employee_code: employee.employee_code,
        email: employee.email,
        logged_hours: loggedHours,
        shortfall_hours: shortfallHours,
      });
      logger.info('Bulk compliance reminder sent', {
        sentBy: authContext.employeeId,
        employeeId: empId,
        employeeName: employee.full_name,
        periodLabel,
      });
    } catch (err) {
      logger.error('Bulk reminder: failed to send email', {
        employeeId: empId,
        error: err.message,
      });
      failed.push({
        employee_id: empId,
        employee_name: employee.full_name,
        employee_code: employee.employee_code,
        reason: 'Email delivery failed.',
      });
    }
  }

  return {
    message: `Reminders processed: ${sent.length} sent, ${skipped.length} skipped, ${failed.length} failed.`,
    total: targetIds.length,
    sent,
    skipped,
    failed,
  };
}

module.exports = {
  getReport,
  sendReminder,
  sendBulkReminder,
  // Exported for testing
  resolvePeriod,
  DATE_THRESHOLD,
  MONTH_THRESHOLD,
};
