'use strict';

const emailService = require('../utils/emailService');
const emailLogRepository = require('../repositories/emailLogRepository');
const logger = require('../utils/logger');

/**
 * Email Log Service
 *
 * Single, application-wide entry point for sending an email AND persisting
 * an `email_logs` row for it (see
 * database/migrations/20260892_create_email_logs.sql). Every feature that
 * sends an email (Forgot Password OTP, Approval Reminder, Work Log
 * Compliance Reminder, and any future one) should call sendAndLog() here
 * instead of wrapping emailService.sendEmail() locally, so email_logs stays
 * a complete record of every outbound email regardless of which feature
 * triggered it.
 */

const MAIL_TYPES = {
  PASSWORD_RESET_OTP: 'PASSWORD_RESET_OTP',
  APPROVAL_REMINDER: 'APPROVAL_REMINDER',
  WORKLOG_COMPLIANCE_REMINDER: 'WORKLOG_COMPLIANCE_REMINDER',
};

/**
 * Promisified wrapper around the callback-based emailService.sendEmail() —
 * see emailService.js's doc comment: that file is MANDATORY/VERBATIM and
 * every async caller wraps it locally rather than converting it. This is
 * that one wrapper, now shared by every caller of sendAndLog() below
 * instead of each feature duplicating its own copy.
 */
function sendEmailRaw(to, subject, body) {
  return new Promise((resolve, reject) => {
    emailService.sendEmail(to, subject, body, (err, message, response) => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve({ message, response });
    });
  });
}

/**
 * Send one email and persist an `email_logs` row for it — always exactly
 * one row, whether the send succeeds or fails, so a failed delivery is
 * never silently missing from the history.
 *
 * On failure, the original send error is re-thrown AFTER the log row is
 * written — every existing caller's error handling (OTP: log and continue;
 * Approval/Compliance Reminder: surface a 502) is unchanged; this function
 * only adds the audit row as a side effect. A failure to WRITE the log row
 * itself is caught, logged, and swallowed — it must never mask the actual
 * send result.
 *
 * @param {object} params
 * @param {string} params.to
 * @param {string} params.subject
 * @param {string} params.html
 * @param {string} params.mailType - one of MAIL_TYPES
 * @param {number|null} [params.companyId]
 * @param {number|null} [params.triggeredByEmployeeId] - who initiated the send; null if system-triggered (e.g. Forgot Password, unauthenticated)
 * @param {number|null} [params.relatedEmployeeId] - the employee this email is about/for, when applicable
 * @returns {Promise<{ message: string, response: * }>}
 * @throws {Error} the original emailService send error (re-thrown after logging)
 */
async function sendAndLog({
  to,
  subject,
  html,
  mailType,
  companyId = null,
  triggeredByEmployeeId = null,
  relatedEmployeeId = null,
}) {
  let result;
  let sendError = null;
  try {
    result = await sendEmailRaw(to, subject, html);
  } catch (err) {
    sendError = err;
  }

  try {
    await emailLogRepository.create({
      company_id: companyId,
      mail_type: mailType,
      recipient_email: to,
      subject,
      body: html,
      status: sendError ? 'failed' : 'sent',
      error_message: sendError ? sendError.message : null,
      triggered_by_employee_id: triggeredByEmployeeId,
      related_employee_id: relatedEmployeeId,
    });
  } catch (logErr) {
    logger.error('Failed to write email_logs row', { mailType, to, error: logErr.message });
  }

  if (sendError) throw sendError;
  return result;
}

module.exports = {
  sendAndLog,
  MAIL_TYPES,
};
