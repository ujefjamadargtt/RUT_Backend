'use strict';

/**
 * Email templates (HTML). Table-based layout + inline styles throughout —
 * required for consistent rendering across email clients (Outlook in
 * particular does not support most modern CSS), and kept mobile-responsive
 * via a fluid max-width container.
 */

const OTP_EMAIL_SUBJECT = 'Password Reset Verification Code';

/**
 * Build the OTP verification email body.
 *
 * @param {string} otp - plaintext 6-digit OTP (never the stored hash)
 * @param {number} [validityMinutes=5]
 * @returns {string} HTML
 */
function buildOtpEmailHtml(otp, validityMinutes = 5) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${OTP_EMAIL_SUBJECT}</title>
  </head>
  <body style="margin:0; padding:0; background-color:#f4f5f7; font-family:Arial, Helvetica, sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7; padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px; width:100%; background-color:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 1px 4px rgba(0,0,0,0.08);">
            <tr>
              <td style="background-color:#1a3d6d; padding:20px 32px;">
                <span style="color:#ffffff; font-size:18px; font-weight:bold;">GTT Data Solutions Limited</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <p style="margin:0 0 16px 0; font-size:15px; color:#1f2937;">Hello,</p>
                <p style="margin:0 0 16px 0; font-size:15px; color:#1f2937; line-height:1.5;">
                  We received a request to reset your password. Please use the following
                  One-Time Password (OTP) to verify your identity.
                </p>

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
                  <tr>
                    <td align="center" style="border:1px dashed #c7cdd6; border-radius:6px; padding:20px; background-color:#f8fafc;">
                      <p style="margin:0 0 8px 0; font-size:12px; letter-spacing:0.5px; text-transform:uppercase; color:#6b7280;">Your OTP</p>
                      <p style="margin:0; font-size:32px; font-weight:bold; letter-spacing:6px; color:#1a3d6d;">${otp}</p>
                    </td>
                  </tr>
                </table>

                <p style="margin:0 0 16px 0; font-size:14px; color:#374151; line-height:1.5;">
                  This OTP is valid for <strong>${validityMinutes} minutes</strong>.
                </p>
                <p style="margin:0 0 16px 0; font-size:14px; color:#374151; line-height:1.5;">
                  For your security, do not share this OTP with anyone.
                </p>
                <p style="margin:0 0 24px 0; font-size:14px; color:#374151; line-height:1.5;">
                  If you did not request a password reset, you can safely ignore this email.
                </p>

                <p style="margin:0; font-size:14px; color:#1f2937;">Regards,</p>
                <p style="margin:0; font-size:14px; color:#1f2937; font-weight:bold;">GTT Data Solutions Limited</p>
              </td>
            </tr>
            <tr>
              <td style="background-color:#f8fafc; padding:16px 32px; text-align:center;">
                <p style="margin:0; font-size:11px; color:#9ca3af;">This is an automated message — please do not reply to this email.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/**
 * Minimal HTML-escaping for free-text values (employee/manager full_name)
 * interpolated into the templates below — these come from the database,
 * not a fixed constant like the OTP, so they're escaped before going into
 * an HTML email body.
 * @param {*} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Build the "Remind for Approval" email subject — dynamic per employee.
 * @param {string} employeeName
 * @returns {string}
 */
function buildApprovalReminderEmailSubject(employeeName) {
  return `Reminder: Work Log Approval Pending for ${employeeName}`;
}

/**
 * Build the "Remind for Approval" email body — sent to an Employee's
 * PRIMARY Manager when the Employee clicks "Remind" on their own pending
 * work logs (see employeeTimesheetService.remindPrimaryManagerForApproval).
 * Purely a notification: sending this email never changes any work log's
 * approval status, and the CTA link only ever takes the manager to the
 * application, where they must still authenticate and be re-authorized
 * against this specific employee before seeing anything.
 *
 * @param {object} params
 * @param {string} params.employeeName
 * @param {string} params.managerName
 * @param {string} params.approvalUrl - deep link to the employee's Approval page
 * @param {string|null} [params.period] - e.g. "01 Aug 2026 - 02 Sep 2026"; omitted if unavailable
 * @param {number} [params.pendingCount]
 * @returns {string} HTML
 */
function buildApprovalReminderEmailHtml({ employeeName, managerName, approvalUrl, period, pendingCount }) {
  const safeEmployeeName = escapeHtml(employeeName);
  const safeManagerName = escapeHtml(managerName);
  const hasCount = Number.isInteger(pendingCount);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Work Log Approval Reminder</title>
  </head>
  <body style="margin:0; padding:0; background-color:#f4f5f7; font-family:Arial, Helvetica, sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7; padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px; width:100%; background-color:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 1px 4px rgba(0,0,0,0.08);">
            <tr>
              <td style="background-color:#1a3d6d; padding:20px 32px;">
                <span style="color:#ffffff; font-size:18px; font-weight:bold;">GTT Data Solutions Limited</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <p style="margin:0 0 16px 0; font-size:15px; color:#1f2937;">Hi ${safeManagerName},</p>
                <p style="margin:0 0 16px 0; font-size:15px; color:#1f2937; line-height:1.5;">
                  <strong>${safeEmployeeName}</strong> has sent you a reminder that their work logs/timesheet are pending your approval.
                </p>
                <p style="margin:0 0 24px 0; font-size:14px; color:#374151; line-height:1.5;">
                  Please review the submitted work logs and take the required action.
                </p>

                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px 0;">
                  <tr>
                    <td align="center" bgcolor="#1a3d6d" style="border-radius:6px;">
                      <a href="${approvalUrl}" target="_blank" style="display:inline-block; padding:12px 28px; font-size:14px; font-weight:bold; color:#ffffff; text-decoration:none; border-radius:6px;">Go to Approval</a>
                    </td>
                  </tr>
                </table>

                <p style="margin:0; font-size:14px; color:#1f2937;">Regards,</p>
                <p style="margin:0; font-size:14px; color:#1f2937; font-weight:bold;">Trackio</p>
              </td>
            </tr>
            <tr>
              <td style="background-color:#f8fafc; padding:16px 32px; text-align:center;">
                <p style="margin:0; font-size:11px; color:#9ca3af;">This is an automated message — please do not reply to this email.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/**
 * Build the work-log compliance reminder email subject.
 *
 * @param {string} periodLabel - e.g. "28 Aug 2026" or "August 2026"
 * @returns {string}
 */
function buildWorkLogComplianceReminderSubject(periodLabel) {
  return `Reminder: Please Complete Your Work Log for ${periodLabel}`;
}

/**
 * Build the work-log compliance reminder email body — sent DIRECTLY to the
 * employee (not their manager) when a manager/admin clicks "Remind" on the
 * Employee Work Log Compliance report.
 *
 * @param {object} params
 * @param {string} params.employeeName
 * @param {string} params.periodLabel   - "28 Aug 2026" (date) or "August 2026" (month)
 * @param {number} params.loggedHours
 * @param {number} params.requiredHours
 * @param {number} params.shortfallHours
 * @param {string} params.timesheetUrl  - absolute URL to /employee/timesheet
 * @returns {string} HTML
 */
function buildWorkLogComplianceReminderHtml({
  employeeName,
  periodLabel,
  loggedHours,
  requiredHours,
  shortfallHours,
  timesheetUrl,
}) {
  const safeName = escapeHtml(employeeName);
  const safePeriod = escapeHtml(periodLabel);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Work Log Reminder</title>
  </head>
  <body style="margin:0; padding:0; background-color:#f4f5f7; font-family:Arial, Helvetica, sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7; padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px; width:100%; background-color:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 1px 4px rgba(0,0,0,0.08);">
            <tr>
              <td style="background-color:#1a3d6d; padding:20px 32px;">
                <span style="color:#ffffff; font-size:18px; font-weight:bold;">GTT Data Solutions Limited</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <p style="margin:0 0 16px 0; font-size:15px; color:#1f2937;">Hi ${safeName},</p>
                <p style="margin:0 0 16px 0; font-size:15px; color:#1f2937; line-height:1.5;">
                  Your work log/timesheet for <strong>${safePeriod}</strong> is currently incomplete.
                </p>

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0; border:1px solid #e5e7eb; border-radius:6px; overflow:hidden;">
                  <tr style="background-color:#f8fafc;">
                    <td style="padding:10px 16px; font-size:13px; color:#6b7280; font-weight:bold; border-bottom:1px solid #e5e7eb;">Logged Hours</td>
                    <td style="padding:10px 16px; font-size:14px; color:#1f2937; font-weight:bold; text-align:right; border-bottom:1px solid #e5e7eb;">${loggedHours} hours</td>
                  </tr>
                  <tr>
                    <td style="padding:10px 16px; font-size:13px; color:#6b7280; font-weight:bold; border-bottom:1px solid #e5e7eb;">Required Hours</td>
                    <td style="padding:10px 16px; font-size:14px; color:#1f2937; font-weight:bold; text-align:right; border-bottom:1px solid #e5e7eb;">${requiredHours} hours</td>
                  </tr>
                  <tr style="background-color:#fef9f0;">
                    <td style="padding:10px 16px; font-size:13px; color:#d97706; font-weight:bold;">Remaining Hours</td>
                    <td style="padding:10px 16px; font-size:14px; color:#d97706; font-weight:bold; text-align:right;">${shortfallHours} hours</td>
                  </tr>
                </table>

                <p style="margin:0 0 24px 0; font-size:14px; color:#374151; line-height:1.5;">
                  Please complete your work log/timesheet at the earliest.
                </p>

                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px 0;">
                  <tr>
                    <td align="center" bgcolor="#1a3d6d" style="border-radius:6px;">
                      <a href="${timesheetUrl}" target="_blank" style="display:inline-block; padding:12px 28px; font-size:14px; font-weight:bold; color:#ffffff; text-decoration:none; border-radius:6px;">Go to Timesheet</a>
                    </td>
                  </tr>
                </table>

                <p style="margin:0; font-size:14px; color:#1f2937;">Regards,</p>
                <p style="margin:0; font-size:14px; color:#1f2937; font-weight:bold;">Trackio</p>
              </td>
            </tr>
            <tr>
              <td style="background-color:#f8fafc; padding:16px 32px; text-align:center;">
                <p style="margin:0; font-size:11px; color:#9ca3af;">This is an automated message — please do not reply to this email.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

module.exports = {
  OTP_EMAIL_SUBJECT,
  buildOtpEmailHtml,
  buildApprovalReminderEmailSubject,
  buildApprovalReminderEmailHtml,
  buildWorkLogComplianceReminderSubject,
  buildWorkLogComplianceReminderHtml,
};
