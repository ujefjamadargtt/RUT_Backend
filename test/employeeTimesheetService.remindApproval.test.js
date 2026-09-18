'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const employeeWorkLogRepository = require('../src/repositories/employeeWorkLogRepository');
const employeeServicePOMappingService = require('../src/services/employeeServicePOMappingService');
const emailService = require('../src/utils/emailService');
const emailLogRepository = require('../src/repositories/emailLogRepository');
const employeeTimesheetService = require('../src/services/employeeTimesheetService');

/**
 * "Remind for Approval" feature — employeeTimesheetService.
 * remindPrimaryManagerForApproval(employeeId, employeeName, companyId).
 *
 * Timesheet Approval redesign: the recipient is no longer the Employee's
 * Primary Manager — it's every Project Manager mapped (via the existing
 * employee_servicepo_mapping table) to a Service PO the Employee has
 * PENDING work against. Same monkeypatch-the-repository-module pattern as
 * before — no real DB/email calls.
 */

const ORIGINAL = {
  getPendingApprovalSummary: employeeWorkLogRepository.getPendingApprovalSummary,
  getPendingServicePOIds: employeeWorkLogRepository.getPendingServicePOIds,
  resolveApprovalRoutingServicePOIds: employeeServicePOMappingService.resolveApprovalRoutingServicePOIds,
  getProjectManagersForServicePOs: employeeServicePOMappingService.getProjectManagersForServicePOs,
  sendEmail: emailService.sendEmail,
  emailLogCreate: emailLogRepository.create,
};

function restore() {
  employeeWorkLogRepository.getPendingApprovalSummary = ORIGINAL.getPendingApprovalSummary;
  employeeWorkLogRepository.getPendingServicePOIds = ORIGINAL.getPendingServicePOIds;
  employeeServicePOMappingService.resolveApprovalRoutingServicePOIds = ORIGINAL.resolveApprovalRoutingServicePOIds;
  employeeServicePOMappingService.getProjectManagersForServicePOs = ORIGINAL.getProjectManagersForServicePOs;
  emailService.sendEmail = ORIGINAL.sendEmail;
  emailLogRepository.create = ORIGINAL.emailLogCreate;
}

function stubEmailLog() {
  const captured = [];
  emailLogRepository.create = async (data) => { captured.push(data); return { id: captured.length, ...data }; };
  return () => captured;
}

function stubPending(count, minDate = '2026-08-01', maxDate = '2026-08-31') {
  employeeWorkLogRepository.getPendingApprovalSummary = async () => ({ count, minDate: count ? minDate : null, maxDate: count ? maxDate : null });
}

function stubPendingServicePOIds(poIds) {
  employeeWorkLogRepository.getPendingServicePOIds = async () => poIds;
  // Identity passthrough by default — the Centralised-PO routing behavior
  // itself is covered by employeeServicePOMappingService.
  // resolveApprovalRoutingServicePOIds's own dedicated tests, plus one
  // end-to-end test below.
  employeeServicePOMappingService.resolveApprovalRoutingServicePOIds = async (employeeId, pendingIds) => pendingIds;
}

function stubProjectManagers(managers) {
  employeeServicePOMappingService.getProjectManagersForServicePOs = async () => managers;
}

function stubEmailSuccessForAll() {
  const captured = [];
  emailService.sendEmail = (to, subject, html, callback) => {
    captured.push({ to, subject, html });
    callback(null, 'EMAIL SEND', {});
  };
  return () => captured;
}

test('remindPrimaryManagerForApproval: no work logs pending -> 400, no PO/PM lookup, no email sent', async () => {
  stubPending(0);
  let lookupCalled = false;
  employeeWorkLogRepository.getPendingServicePOIds = async () => { lookupCalled = true; return []; };
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
  assert.equal(lookupCalled, false, 'must not look up Service PO / Project Manager mappings when nothing is pending');
  assert.equal(emailCalled, false, 'must never send an email when nothing is pending');
  restore();
});

// Real feature request: a pending entry against a Centralised PO (Leaves)
// has no genuine Project Manager of its own — it must be routed through the
// employee's OWN real project's Project Manager(s) instead. This confirms
// the reminder orchestration wires employeeId + the raw pending PO ids into
// resolveApprovalRoutingServicePOIds, and feeds ITS (already-routed) result
// into getProjectManagersForServicePOs — never the raw pending ids directly.
test('remindPrimaryManagerForApproval: a pending Centralised PO (Leaves) is routed through the employee\'s own real project\'s Project Manager(s)', async () => {
  stubPending(1);
  employeeWorkLogRepository.getPendingServicePOIds = async () => [999]; // 999 = "Leaves", Centralised
  let routingArgs = null;
  employeeServicePOMappingService.resolveApprovalRoutingServicePOIds = async (employeeId, pendingIds) => {
    routingArgs = { employeeId, pendingIds };
    return [201]; // 201 = the employee's own real project PO
  };
  let poIdsPassedToPMResolution = null;
  employeeServicePOMappingService.getProjectManagersForServicePOs = async (poIds) => {
    poIdsPassedToPMResolution = poIds;
    return [{ id: 5, full_name: 'Real Project PM', email: 'pm@example.com', status: 'active' }];
  };
  const getCaptured = stubEmailSuccessForAll();
  stubEmailLog();

  const result = await employeeTimesheetService.remindPrimaryManagerForApproval(101, 'ABC Employee', 10);

  assert.deepEqual(routingArgs, { employeeId: 101, pendingIds: [999] });
  assert.deepEqual(poIdsPassedToPMResolution, [201]);
  assert.equal(result.message, 'Reminder sent to 1 Project Manager.');
  assert.equal(getCaptured().length, 1);
  restore();
});

test('remindPrimaryManagerForApproval: no Project Manager mapped to the pending Service PO(s) -> 400, no email sent', async () => {
  stubPending(2);
  stubPendingServicePOIds([201]);
  stubProjectManagers([]);
  let emailCalled = false;
  emailService.sendEmail = () => { emailCalled = true; };

  await assert.rejects(
    () => employeeTimesheetService.remindPrimaryManagerForApproval(101, 'ABC Employee', 10),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /No Project Manager/);
      return true;
    }
  );
  assert.equal(emailCalled, false);
  restore();
});

test('remindPrimaryManagerForApproval: Project Manager(s) found but none have an email configured -> 400, no email sent', async () => {
  stubPending(2);
  stubPendingServicePOIds([201]);
  stubProjectManagers([{ id: 5, full_name: 'PM No Email', email: null, status: 'active' }]);
  let emailCalled = false;
  emailService.sendEmail = () => { emailCalled = true; };

  await assert.rejects(
    () => employeeTimesheetService.remindPrimaryManagerForApproval(101, 'ABC Employee', 10),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /No Project Manager with an email address/);
      return true;
    }
  );
  assert.equal(emailCalled, false);
  restore();
});

test('remindPrimaryManagerForApproval: happy path, single Project Manager — sends exactly one email, with employee/PM names, period, and a "Go to Approval" CTA link', async () => {
  stubPending(3, '2026-08-01', '2026-08-15');
  stubPendingServicePOIds([201]);
  stubProjectManagers([{ id: 5, full_name: 'PM One', email: 'pm1@example.com', status: 'active' }]);
  const getCaptured = stubEmailSuccessForAll();
  const getLoggedRows = stubEmailLog();

  const result = await employeeTimesheetService.remindPrimaryManagerForApproval(101, 'ABC Employee', 10);

  assert.equal(result.message, 'Reminder sent to 1 Project Manager.');
  assert.deepEqual(result.recipients, [{ name: 'PM One' }]);
  assert.equal(result.pendingCount, 3);
  assert.equal(result.period, '01 Aug 2026 - 15 Aug 2026');

  const captured = getCaptured();
  assert.equal(captured.length, 1);
  assert.equal(captured[0].to, 'pm1@example.com');
  assert.match(captured[0].subject, /Reminder: Work Log Approval Pending for ABC Employee/);
  assert.match(captured[0].html, /ABC Employee/);
  assert.match(captured[0].html, /PM One/);
  assert.match(captured[0].html, /Go to Approval/);
  assert.match(captured[0].html, /employee_id=101/);

  const loggedRows = getLoggedRows();
  assert.equal(loggedRows.length, 1);
  assert.equal(loggedRows[0].mail_type, 'APPROVAL_REMINDER');
  assert.equal(loggedRows[0].recipient_email, 'pm1@example.com');
  assert.equal(loggedRows[0].status, 'sent');
  restore();
});

// Decision requirement: "PO1 -> PM ABC, PM XYZ, PM PQR — all three should
// receive the reminder."
test('remindPrimaryManagerForApproval: a Service PO with multiple Project Managers sends a separate email to EACH of them', async () => {
  stubPending(1);
  stubPendingServicePOIds([201]);
  stubProjectManagers([
    { id: 5, full_name: 'PM ABC', email: 'abc@example.com', status: 'active' },
    { id: 6, full_name: 'PM XYZ', email: 'xyz@example.com', status: 'active' },
    { id: 7, full_name: 'PM PQR', email: 'pqr@example.com', status: 'active' },
  ]);
  const getCaptured = stubEmailSuccessForAll();
  stubEmailLog();

  const result = await employeeTimesheetService.remindPrimaryManagerForApproval(101, 'ABC Employee', 10);

  assert.equal(result.message, 'Reminder sent to 3 Project Managers.');
  const captured = getCaptured();
  assert.equal(captured.length, 3);
  assert.deepEqual(captured.map((c) => c.to).sort(), ['abc@example.com', 'pqr@example.com', 'xyz@example.com']);
  restore();
});

// Decision requirement: "If the same PM is mapped to multiple POs for the
// same employee, send only one reminder email to that PM." Dedup itself
// happens inside employeeServicePOMappingService.getProjectManagersForServicePOs
// (see its own tests) — this confirms the reminder orchestration sends
// exactly one email per entry that function returns, never more.
test('remindPrimaryManagerForApproval: never sends more than one email per Project Manager, even across multiple pending Service POs', async () => {
  stubPending(4);
  stubPendingServicePOIds([201, 202]);
  // getProjectManagersForServicePOs is trusted to already be deduplicated —
  // simulate its real (deduplicated) output for a PM mapped to both POs.
  stubProjectManagers([{ id: 5, full_name: 'PM Both POs', email: 'both@example.com', status: 'active' }]);
  const getCaptured = stubEmailSuccessForAll();
  stubEmailLog();

  const result = await employeeTimesheetService.remindPrimaryManagerForApproval(101, 'ABC Employee', 10);

  assert.equal(result.message, 'Reminder sent to 1 Project Manager.');
  assert.equal(getCaptured().length, 1);
  restore();
});

test('remindPrimaryManagerForApproval: partial send failure still succeeds as long as at least one Project Manager received it', async () => {
  stubPending(1);
  stubPendingServicePOIds([201]);
  stubProjectManagers([
    { id: 5, full_name: 'PM Fails', email: 'fails@example.com', status: 'active' },
    { id: 6, full_name: 'PM Succeeds', email: 'ok@example.com', status: 'active' },
  ]);
  emailService.sendEmail = (to, subject, html, callback) => {
    if (to === 'fails@example.com') return callback('EMAIL SEND ERROR.');
    callback(null, 'EMAIL SEND', {});
  };
  stubEmailLog();

  const result = await employeeTimesheetService.remindPrimaryManagerForApproval(101, 'ABC Employee', 10);

  assert.equal(result.message, 'Reminder sent to 1 Project Manager.');
  assert.deepEqual(result.recipients, [{ name: 'PM Succeeds' }]);
  restore();
});

test('remindPrimaryManagerForApproval: email provider failure for EVERY recipient -> 502, work-log/approval data untouched', async () => {
  stubPending(1);
  stubPendingServicePOIds([201]);
  stubProjectManagers([{ id: 5, full_name: 'PM One', email: 'pm1@example.com', status: 'active' }]);
  emailService.sendEmail = (to, subject, html, callback) => callback('EMAIL SEND ERROR.');
  const getLoggedRows = stubEmailLog();

  await assert.rejects(
    () => employeeTimesheetService.remindPrimaryManagerForApproval(101, 'ABC Employee', 10),
    (err) => {
      assert.equal(err.statusCode, 502);
      assert.match(err.message, /Unable to send reminder email/);
      return true;
    }
  );
  const loggedRows = getLoggedRows();
  assert.equal(loggedRows.length, 1);
  assert.equal(loggedRows[0].status, 'failed');
  assert.match(loggedRows[0].error_message, /EMAIL SEND ERROR/);
  restore();
});
