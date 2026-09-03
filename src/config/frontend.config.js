'use strict';

/**
 * Frontend base URL + Employee Approval page route — used to build the
 * "Go to Approval" deep link in the Remind-for-Approval reminder email
 * (see employeeTimesheetService.remindPrimaryManagerForApproval). Both are
 * env-overridable so the link always points at whichever frontend origin
 * and route a given environment actually serves, never a hardcoded
 * localhost/production domain — see .env.example.
 *
 * FRONTEND_APPROVAL_PATH carries an `{employeeId}` placeholder and defaults
 * to a query-string shape matching the existing Manager "Approval Summary"
 * contract (GET /my-team/timesheets/approval-summary?employee_id=...) —
 * override this env var (no code change needed) if the frontend's actual
 * Employee Approval page route differs.
 */
const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');
const FRONTEND_APPROVAL_PATH = process.env.FRONTEND_APPROVAL_PATH || '/my-team/timesheets?employee_id={employeeId}';

// The existing Employee Timesheet page route — used by the Work Log
// Compliance reminder email "Go to Timesheet" CTA. Override via
// FRONTEND_TIMESHEET_PATH env var if the frontend serves the page at a
// different path.
const FRONTEND_TIMESHEET_PATH = process.env.FRONTEND_TIMESHEET_PATH || '/employee/timesheet';

/**
 * @param {number} employeeId
 * @returns {string} absolute URL to the Employee Approval page for one employee
 */
function getApprovalUrl(employeeId) {
  const path = FRONTEND_APPROVAL_PATH.replace('{employeeId}', encodeURIComponent(employeeId));
  return `${FRONTEND_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Absolute URL to the Employee Timesheet page — used as the "Go to
 * Timesheet" CTA link in Work Log Compliance reminder emails.
 * @returns {string}
 */
function getTimesheetUrl() {
  const path = FRONTEND_TIMESHEET_PATH;
  return `${FRONTEND_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

module.exports = {
  FRONTEND_URL,
  FRONTEND_APPROVAL_PATH,
  FRONTEND_TIMESHEET_PATH,
  getApprovalUrl,
  getTimesheetUrl,
};
