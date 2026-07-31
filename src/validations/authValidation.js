'use strict';

const Joi = require('joi');

/**
 * Auth Validation Schemas
 */

// Shared by loginSchema and the forgot-password family below — 'user' |
// 'employee', OPTIONAL for /login and /forgot-password (only needed when
// the email resolves to both a User and an Employee), REQUIRED for
// /verify-otp and /reset-password (see their schemas further down).
const loginTypeField = Joi.string()
  .trim()
  .lowercase()
  .valid('user', 'employee')
  .messages({
    'any.only': "loginType must be 'user' or 'employee'.",
  });

/**
 * POST /auth/login
 */
const loginSchema = Joi.object({
  email: Joi.string()
    .email({ tlds: { allow: false } })
    .lowercase()
    .trim()
    .required()
    .messages({
      'string.base': 'Email must be a string.',
      'string.email': 'Please provide a valid email address.',
      'string.empty': 'Email is required.',
      'any.required': 'Email is required.',
    }),

  password: Joi.string()
    .min(6)
    .required()
    .messages({
      'string.base': 'Password must be a string.',
      'string.min': 'Password must be at least 6 characters.',
      'string.empty': 'Password is required.',
      'any.required': 'Password is required.',
    }),

  // Optional — only required when the email is registered as BOTH a User
  // and an Employee (see authService.login's dual-lookup / accountTypes
  // disambiguation). Omitting it is fully backward compatible.
  loginType: loginTypeField.optional(),
});

/**
 * POST /auth/refresh-token
 */
const refreshTokenSchema = Joi.object({
  refresh_token: Joi.string()
    .trim()
    .required()
    .messages({
      'string.empty': 'Refresh token is required.',
      'any.required': 'Refresh token is required.',
    }),
});

/**
 * POST /auth/change-password
 */
const changePasswordSchema = Joi.object({
  current_password: Joi.string()
    .min(6)
    .required()
    .messages({
      'string.min': 'Current password must be at least 6 characters.',
      'any.required': 'Current password is required.',
    }),

  new_password: Joi.string()
    .min(8)
    .pattern(/[A-Z]/, 'uppercase letter')
    .pattern(/[a-z]/, 'lowercase letter')
    .pattern(/[0-9]/, 'digit')
    .pattern(/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/, 'special character')
    .disallow(Joi.ref('current_password'))
    .required()
    .messages({
      'string.min': 'New password must be at least 8 characters.',
      'string.pattern.name': 'New password must contain at least one {#name}.',
      'any.invalid': 'New password must differ from your current password.',
      'any.required': 'New password is required.',
    }),

  confirm_password: Joi.string()
    .valid(Joi.ref('new_password'))
    .required()
    .messages({
      'any.only': 'Confirm password must match the new password.',
      'any.required': 'Confirm password is required.',
    }),
});

// ─── Forgot Password (User + Employee, OTP-based) ─────────────────────────────
// Replaces the previous forgotPasswordSchema/resetPasswordSchema, which were
// dead code (never wired to a route/controller) shaped for a different,
// reset-link-token design. Field names below are camelCase (email/otp/
// password/confirmPassword) to match this feature's spec exactly, even
// though the rest of this file uses snake_case — a deliberate exception,
// not an inconsistency to "fix."

const emailField = Joi.string()
  .email({ tlds: { allow: false } })
  .lowercase()
  .trim()
  .required()
  .messages({
    'string.email': 'Please provide a valid email address.',
    'any.required': 'Email is required.',
  });

const otpField = Joi.string()
  .trim()
  .pattern(/^\d{6}$/)
  .required()
  .messages({
    'string.pattern.base': 'OTP must be a 6-digit number.',
    'any.required': 'OTP is required.',
  });

// Same complexity policy as userValidation.js's changePasswordSchema —
// reused here for the reset flow's new password.
const passwordPolicyField = Joi.string()
  .min(8)
  .pattern(/[A-Z]/, 'uppercase letter')
  .pattern(/[a-z]/, 'lowercase letter')
  .pattern(/[0-9]/, 'digit')
  .pattern(/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/, 'special character')
  .required()
  .messages({
    'string.min': 'Password must be at least 8 characters.',
    'string.pattern.name': 'Password must contain at least one {#name}.',
    'any.required': 'Password is required.',
  });

/**
 * PUT /auth/change-password
 * Body is ONLY { newPassword } — id/userType are resolved from the verified
 * JWT (see middlewares/dualAuth.js), never accepted from the request body,
 * per the "trust only the authenticated token" security requirement.
 * Reuses the SAME password-complexity policy as /auth/reset-password.
 */
const directChangePasswordSchema = Joi.object({
  newPassword: passwordPolicyField,
});

/**
 * POST /auth/forgot-password
 * loginType is OPTIONAL — only required when the email resolves to both a
 * User and an Employee (mirrors loginSchema's loginType).
 */
const forgotPasswordSchema = Joi.object({
  email: emailField,
  loginType: loginTypeField.optional(),
});

/**
 * POST /auth/verify-otp
 * loginType is REQUIRED here — it disambiguates which OTP stream (User's
 * or Employee's) is being verified, and is the enforcement point for
 * "never allow a User OTP to verify against an Employee reset, or vice
 * versa" (see passwordResetRepository.findLivePendingByEmail).
 */
const verifyOtpSchema = Joi.object({
  email: emailField,
  otp: otpField,
  loginType: loginTypeField.required().messages({
    'any.required': 'loginType is required.',
  }),
});

/**
 * POST /auth/resend-otp
 * loginType is OPTIONAL — same disambiguation semantics as forgot-password.
 */
const resendOtpSchema = Joi.object({
  email: emailField,
  loginType: loginTypeField.optional(),
});

/**
 * POST /auth/reset-password
 * loginType is REQUIRED — same reasoning as verify-otp.
 */
const resetPasswordSchema = Joi.object({
  email: emailField,
  otp: otpField,
  password: passwordPolicyField,
  confirmPassword: Joi.string()
    .valid(Joi.ref('password'))
    .required()
    .messages({
      'any.only': 'Passwords do not match.',
      'any.required': 'Confirm password is required.',
    }),
  loginType: loginTypeField.required().messages({
    'any.required': 'loginType is required.',
  }),
});

module.exports = {
  loginSchema,
  refreshTokenSchema,
  changePasswordSchema,
  directChangePasswordSchema,
  forgotPasswordSchema,
  verifyOtpSchema,
  resendOtpSchema,
  resetPasswordSchema,
};
