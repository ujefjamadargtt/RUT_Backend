'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const emailService = require('../src/utils/emailService');
const emailLogRepository = require('../src/repositories/emailLogRepository');
const emailLogService = require('../src/services/emailLogService');

/**
 * emailLogService.sendAndLog — the single shared "send an email AND write
 * an email_logs row" entry point every feature (Forgot Password OTP,
 * Approval Reminder, Work Log Compliance Reminder) now calls instead of
 * wrapping emailService.sendEmail() locally. No real DB/email calls —
 * emailService.sendEmail and emailLogRepository.create are monkeypatched
 * for the duration of each test, same pattern as the rest of this suite.
 */

const ORIGINAL = {
  sendEmail: emailService.sendEmail,
  create: emailLogRepository.create,
};

function restore() {
  emailService.sendEmail = ORIGINAL.sendEmail;
  emailLogRepository.create = ORIGINAL.create;
}

function stubEmailSuccess() {
  emailService.sendEmail = (to, subject, body, callback) => callback(null, 'EMAIL SEND', { ok: true });
}

function stubEmailFailure(message = 'EMAIL SEND ERROR.') {
  emailService.sendEmail = (to, subject, body, callback) => callback(message);
}

function stubLogCapture() {
  let captured = null;
  emailLogRepository.create = async (data) => { captured = data; return { id: 1, ...data }; };
  return () => captured;
}

test('sendAndLog: success -> resolves, and writes one email_logs row with status "sent" and no error_message', async () => {
  stubEmailSuccess();
  const getRow = stubLogCapture();

  const result = await emailLogService.sendAndLog({
    to: 'abc@example.com',
    subject: 'Hello',
    html: '<p>Hi</p>',
    mailType: emailLogService.MAIL_TYPES.PASSWORD_RESET_OTP,
    companyId: 10,
    triggeredByEmployeeId: null,
    relatedEmployeeId: null,
  });

  assert.equal(result.message, 'EMAIL SEND');
  const row = getRow();
  assert.equal(row.mail_type, 'PASSWORD_RESET_OTP');
  assert.equal(row.recipient_email, 'abc@example.com');
  assert.equal(row.subject, 'Hello');
  assert.equal(row.body, '<p>Hi</p>');
  assert.equal(row.status, 'sent');
  assert.equal(row.error_message, null);
  assert.equal(row.company_id, 10);
  restore();
});

test('sendAndLog: send failure -> rejects with the original error, but still writes one email_logs row with status "failed" and the error message', async () => {
  stubEmailFailure('EMAIL SEND ERROR.');
  const getRow = stubLogCapture();

  await assert.rejects(
    () => emailLogService.sendAndLog({
      to: 'xyz@example.com',
      subject: 'Reminder',
      html: '<p>Reminder</p>',
      mailType: emailLogService.MAIL_TYPES.APPROVAL_REMINDER,
      companyId: 5,
      triggeredByEmployeeId: 101,
      relatedEmployeeId: 101,
    }),
    (err) => {
      assert.match(err.message, /EMAIL SEND ERROR/);
      return true;
    }
  );

  const row = getRow();
  assert.equal(row.status, 'failed');
  assert.match(row.error_message, /EMAIL SEND ERROR/);
  assert.equal(row.triggered_by_employee_id, 101);
  assert.equal(row.related_employee_id, 101);
  restore();
});

test('sendAndLog: a failure to WRITE the log row is swallowed — the actual send result (success) still comes through untouched', async () => {
  stubEmailSuccess();
  emailLogRepository.create = async () => { throw new Error('DB unavailable'); };

  const result = await emailLogService.sendAndLog({
    to: 'abc@example.com',
    subject: 'Hello',
    html: '<p>Hi</p>',
    mailType: emailLogService.MAIL_TYPES.WORKLOG_COMPLIANCE_REMINDER,
  });

  assert.equal(result.message, 'EMAIL SEND');
  restore();
});

test('sendAndLog: a failure to WRITE the log row is swallowed even when the send itself also failed — the original send error still surfaces, not the logging error', async () => {
  stubEmailFailure('EMAIL SEND ERROR.');
  emailLogRepository.create = async () => { throw new Error('DB unavailable'); };

  await assert.rejects(
    () => emailLogService.sendAndLog({
      to: 'xyz@example.com',
      subject: 'Reminder',
      html: '<p>Reminder</p>',
      mailType: emailLogService.MAIL_TYPES.WORKLOG_COMPLIANCE_REMINDER,
    }),
    (err) => {
      assert.match(err.message, /EMAIL SEND ERROR/);
      return true;
    }
  );
  restore();
});
