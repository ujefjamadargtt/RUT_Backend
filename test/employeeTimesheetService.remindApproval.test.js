'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const employeeWorkLogRepository = require('../src/repositories/employeeWorkLogRepository');
const managerEmployeeMappingRepository = require('../src/repositories/managerEmployeeMappingRepository');
const emailService = require('../src/utils/emailService');
const emailLogRepository = require('../src/repositories/emailLogRepository');
const employeeTimesheetService = require('../src/services/employeeTimesheetService');

/**
 * "Remind for Approval" feature — employeeTimesheetService.
 * remindPrimaryManagerForApproval(employeeId, employeeName, companyId).
 * Follows the same monkeypatch-the-repository-module pattern as
 * employeeTimesheetService.descriptionOptional.test.js — no real DB/email
 * calls, module-level exports are swapped for the duration of each test.
 * emailLogRepository.create is stubbed too (emailLogService.sendAndLog now
 * writes an email_logs row alongside every send) so these stay pure unit
 * tests with no real database dependency.
 */

const ORIGINAL = {
  getPendingApprovalSummary: employeeWorkLogRepository.getPendingApprovalSummary,
  findActivePrimaryManagerForEmployee: managerEmployeeMappingRepository.findActivePrimaryManagerForEmployee,
  sendEmail: emailService.sendEmail,
  emailLogCreate: emailLogRepository.create,
};

function restore() {
  employeeWorkLogRepository.getPendingApprovalSummary = ORIGINAL.getPendingApprovalSummary;
  managerEmployeeMappingRepository.findActivePrimaryManagerForEmployee = ORIGINAL.findActivePrimaryManagerForEmployee;
  emailService.sendEmail = ORIGINAL.sendEmail;
  emailLogRepository.create = ORIGINAL.emailLogCreate;
}

function stubEmailLog() {
  let captured = null;
  emailLogRepository.create = async (data) => { captured = data; return { id: 1, ...data }; };
  return () => captured;
}

function stubPending(count, minDate = '2026-08-01', maxDate = '2026-08-31') {
  employeeWorkLogRepository.getPendingApprovalSummary = async () => ({ count, minDate: count ? minDate : null, maxDate: count ? maxDate : null });
}

function stubPrimaryManager(manager) {
  managerEmployeeMappingRepository.findActivePrimaryManagerForEmployee = async () => (manager ? { manager } : null);
}

function stubEmailSuccess() {
  let captured = null;
  emailService.sendEmail = (to, subject, html, callback) => {
    captured = { to, subject, html };
    callback(null, 'EMAIL SEND', {});
  };
  return () => captured;
}

function stubEmailFailure() {
  emailService.sendEmail = (to, subject, html, callback) => {
    callback('EMAIL SEND ERROR.');
  };
}

test('remindPrimaryManagerForApproval: no work logs pending -> 400, no manager lookup, no email sent', async () => {
  stubPending(0);
  let managerLookupCalled = false;
  managerEmployeeMappingRepository.findActivePrimaryManagerForEmployee = async () => {
    managerLookupCalled = true;
    return null;
  };
  let emailCalled = false;
  emailService.sendEmail = () => { emailCalled = true; };

  await assert.rejects(
    () => employeeTimesheetService.remindPrimaryManagerForApproval(101, 'ABC Employee', 10),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /No work logs are currently pending approval/);
      return true;
    }
  );
  assert.equal(managerLookupCalled, false, 'must not look up a manager when nothing is pending');
  assert.equal(emailCalled, false, 'must never send an email when nothing is pending');
  restore();
});

test('remindPrimaryManagerForApproval: no active PRIMARY manager -> 400, no email sent', async () => {
  stubPending(2);
  stubPrimaryManager(null);
  let emailCalled = false;
  emailService.sendEmail = () => { emailCalled = true; };

  await assert.rejects(
    () => employeeTimesheetService.remindPrimaryManagerForApproval(101, 'ABC Employee', 10),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /Primary manager is not assigned/);
      return true;
    }
  );
  assert.equal(emailCalled, false);
  restore();
});

test('remindPrimaryManagerForApproval: PRIMARY manager mapping exists but manager row is inactive -> 400, no email sent', async () => {
  stubPending(2);
  stubPrimaryManager({ id: 5, full_name: 'XYZ Manager', email: 'xyz@example.com', status: 'inactive' });
  let emailCalled = false;
  emailService.sendEmail = () => { emailCalled = true; };

  await assert.rejects(
    () => employeeTimesheetService.remindPrimaryManagerForApproval(101, 'ABC Employee', 10),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /Primary manager is not assigned/);
      return true;
    }
  );
  assert.equal(emailCalled, false);
  restore();
});

test('remindPrimaryManagerForApproval: manager has no email configured -> 400, no email sent', async () => {
  stubPending(2);
  stubPrimaryManager({ id: 5, full_name: 'XYZ Manager', email: null, status: 'active' });
  let emailCalled = false;
  emailService.sendEmail = () => { emailCalled = true; };

  await assert.rejects(
    () => employeeTimesheetService.remindPrimaryManagerForApproval(101, 'ABC Employee', 10),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /does not have an email address configured/);
      return true;
    }
  );
  assert.equal(emailCalled, false);
  restore();
});

test('remindPrimaryManagerForApproval: happy path — sends exactly one email to the primary manager, with employee/manager names, period, and a "Go to Approval" CTA link, and never touches work log data', async () => {
  stubPending(3, '2026-08-01', '2026-08-15');
  stubPrimaryManager({ id: 5, full_name: 'XYZ Manager', email: 'xyz@example.com', status: 'active' });
  const getCaptured = stubEmailSuccess();
  const getLoggedRow = stubEmailLog();

  const result = await employeeTimesheetService.remindPrimaryManagerForApproval(101, 'ABC Employee', 10);

  assert.equal(result.message, 'Reminder sent to the primary manager.');
  assert.equal(result.managerName, 'XYZ Manager');
  assert.equal(result.pendingCount, 3);
  assert.equal(result.period, '01 Aug 2026 - 15 Aug 2026');

  const captured = getCaptured();
  assert.equal(captured.to, 'xyz@example.com');
  assert.match(captured.subject, /Reminder: Work Log Approval Pending for ABC Employee/);
  assert.match(captured.html, /ABC Employee/);
  assert.match(captured.html, /XYZ Manager/);
  assert.match(captured.html, /Go to Approval/);
  assert.match(captured.html, /employee_id=101/);

  const loggedRow = getLoggedRow();
  assert.equal(loggedRow.mail_type, 'APPROVAL_REMINDER');
  assert.equal(loggedRow.recipient_email, 'xyz@example.com');
  assert.equal(loggedRow.status, 'sent');
  assert.equal(loggedRow.triggered_by_employee_id, 101);
  assert.equal(loggedRow.related_employee_id, 101);
  restore();
});

test('remindPrimaryManagerForApproval: email provider failure -> 502, work-log/approval data untouched (function never wrote to it in the first place), and the failure is still logged to email_logs', async () => {
  stubPending(1);
  stubPrimaryManager({ id: 5, full_name: 'XYZ Manager', email: 'xyz@example.com', status: 'active' });
  stubEmailFailure();
  const getLoggedRow = stubEmailLog();

  await assert.rejects(
    () => employeeTimesheetService.remindPrimaryManagerForApproval(101, 'ABC Employee', 10),
    (err) => {
      assert.equal(err.statusCode, 502);
      assert.match(err.message, /Unable to send reminder email/);
      return true;
    }
  );
  const loggedRow = getLoggedRow();
  assert.equal(loggedRow.status, 'failed');
  assert.match(loggedRow.error_message, /EMAIL SEND ERROR/);
  restore();
});
