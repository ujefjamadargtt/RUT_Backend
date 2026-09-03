'use strict';

const { EmailLog } = require('../models');

/**
 * Email Log Repository
 * Raw database access for `email_logs` — the application-wide outbound
 * email audit trail (see database/migrations/20260892_create_email_logs.sql).
 * No business logic here; see emailLogService.js for the send+log wrapper
 * every feature should call instead of writing rows directly.
 */

/**
 * @param {object} data
 * @param {number|null} [data.company_id]
 * @param {string} data.mail_type
 * @param {string} data.recipient_email
 * @param {string} data.subject
 * @param {string} data.body
 * @param {'sent'|'failed'} data.status
 * @param {string|null} [data.error_message]
 * @param {number|null} [data.triggered_by_employee_id]
 * @param {number|null} [data.related_employee_id]
 * @returns {Promise<EmailLog>}
 */
const create = async (data) => {
  return EmailLog.create(data);
};

module.exports = {
  create,
};
