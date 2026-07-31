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

module.exports = {
  OTP_EMAIL_SUBJECT,
  buildOtpEmailHtml,
};
