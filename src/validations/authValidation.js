'use strict';

const Joi = require('joi');

/**
 * Auth Validation Schemas
 *
 * Every account tier (including Employees) authenticates through User
 * Master only now — see database/migrations/20260842_employees_drop_login_columns.sql
 * — so there is no longer a `loginType` field anywhere in this file.
 */

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
});

/**
 * POST /auth/select-role
 * Completes Role-Based Login for an employee holding multiple active
 * roles — see authService.selectRole().
 */
const selectRoleSchema = Joi.object({
  loginTicket: Joi.string()
    .trim()
    .required()
    .messages({
      'string.empty': 'Login ticket is required.',
      'any.required': 'Login ticket is required.',
    }),

  roleId: Joi.number()
    .integer()
    .positive()
    .required()
    .messages({
      'number.base': 'roleId must be a number.',
      'any.required': 'roleId is required.',
    }),
});

/**
 * POST /auth/microsoft
 *
 * Body carries ONLY the raw Microsoft ID token — the frontend must never
 * send email/role/employeeId/etc. directly; only claims that survive
 * microsoftAuthService's signature/issuer/audience/tenant verification are
 * ever trusted (see authService.loginWithMicrosoft()).
 */
const microsoftLoginSchema = Joi.object({
  idToken: Joi.string()
    .trim()
    .required()
    .messages({
      'string.empty': 'idToken is required.',
      'any.required': 'idToken is required.',
    }),
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
 * Body is ONLY { newPassword } — the user id is resolved from the verified
 * JWT (see middlewares/auth.js), never accepted from the request body, per
 * the "trust only the authenticated token" security requirement. Reuses the
 * SAME password-complexity policy as /auth/reset-password.
 */
const directChangePasswordSchema = Joi.object({
  newPassword: passwordPolicyField,
});

/**
 * POST /auth/forgot-password
 */
const forgotPasswordSchema = Joi.object({
  email: emailField,
});

/**
 * POST /auth/verify-otp
 */
const verifyOtpSchema = Joi.object({
  email: emailField,
  otp: otpField,
});

/**
 * POST /auth/resend-otp
 */
const resendOtpSchema = Joi.object({
  email: emailField,
});

/**
 * POST /auth/reset-password
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
});

module.exports = {
  loginSchema,
  microsoftLoginSchema,
  selectRoleSchema,
  refreshTokenSchema,
  changePasswordSchema,
  directChangePasswordSchema,
  forgotPasswordSchema,
  verifyOtpSchema,
  resendOtpSchema,
  resetPasswordSchema,
};
