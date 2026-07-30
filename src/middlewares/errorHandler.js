'use strict';

const { ValidationError, UniqueConstraintError, ForeignKeyConstraintError, DatabaseError } = require('sequelize');
const { JsonWebTokenError, TokenExpiredError, NotBeforeError } = require('jsonwebtoken');
const multer = require('multer');
const logger = require('../utils/logger');

/**
 * Formats Sequelize validation errors into a flat array of field-level messages.
 * @param {ValidationError} error
 * @returns {Array<{field: string, message: string}>}
 */
const formatSequelizeValidationErrors = (error) => {
  return error.errors.map((e) => ({
    field: e.path,
    message: e.message,
  }));
};

/**
 * Global Error Handler Middleware
 * Must be registered as the LAST middleware in the Express app.
 */
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  // Default error shape
  let statusCode = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'An unexpected error occurred. Please try again later.';
  let errors = null;

  // ── Sequelize Validation Error (422) ──────────────────────────────────────
  if (err instanceof ValidationError) {
    statusCode = 422;
    code = 'VALIDATION_ERROR';
    message = 'Input validation failed.';
    errors = formatSequelizeValidationErrors(err);

  // ── Sequelize Unique Constraint Error (409) ───────────────────────────────
  } else if (err instanceof UniqueConstraintError) {
    statusCode = 409;
    code = 'DUPLICATE_ENTRY';
    const field = err.errors && err.errors[0] ? err.errors[0].path : 'field';
    message = `A record with this ${field} already exists.`;
    errors = formatSequelizeValidationErrors(err);

  // ── Sequelize Foreign Key Constraint Error (422) ──────────────────────────
  } else if (err instanceof ForeignKeyConstraintError) {
    statusCode = 422;
    code = 'FOREIGN_KEY_ERROR';
    message = 'Referenced record does not exist or cannot be deleted due to existing references.';

  // ── Sequelize Database Error (500) ───────────────────────────────────────
  } else if (err instanceof DatabaseError) {
    statusCode = 500;
    code = 'DATABASE_ERROR';
    message = 'A database error occurred.';

  // ── JWT Token Expired (401) ───────────────────────────────────────────────
  } else if (err instanceof TokenExpiredError) {
    statusCode = 401;
    code = 'TOKEN_EXPIRED';
    message = 'Token has expired. Please log in again.';

  // ── JWT Invalid Token (401) ───────────────────────────────────────────────
  } else if (err instanceof JsonWebTokenError || err instanceof NotBeforeError) {
    statusCode = 401;
    code = 'INVALID_TOKEN';
    message = 'Invalid authentication token.';

  // ── Multer Errors (400) ───────────────────────────────────────────────────
  } else if (err instanceof multer.MulterError) {
    statusCode = 400;
    code = 'UPLOAD_ERROR';
    switch (err.code) {
      case 'LIMIT_FILE_SIZE':
        message = 'File is too large. Maximum allowed size is 10MB.';
        break;
      case 'LIMIT_FILE_COUNT':
        message = 'Too many files uploaded at once.';
        break;
      case 'LIMIT_UNEXPECTED_FILE':
        message = `Unexpected field: "${err.field}". Please use the correct upload field name.`;
        break;
      case 'LIMIT_PART_COUNT':
        message = 'Too many form parts in the upload.';
        break;
      default:
        message = `File upload error: ${err.message}`;
    }

  // ── Custom Application Errors ─────────────────────────────────────────────
  } else if (err.isOperational) {
    statusCode = err.statusCode || 400;
    code = err.code || 'APPLICATION_ERROR';
    message = err.message;
    errors = err.errors || null;

  // ── Generic / Unknown Errors (500) ────────────────────────────────────────
  } else {
    statusCode = err.statusCode || err.status || 500;
    code = err.code || 'INTERNAL_ERROR';
    message = statusCode < 500 ? err.message : 'An unexpected error occurred.';
  }

  // ── Logging ───────────────────────────────────────────────────────────────
  const logContext = {
    statusCode,
    code,
    method: req.method,
    path: req.originalUrl || req.path,
    userId: req.userId || null,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    errorName: err.name,
    errorMessage: err.message,
  };

  if (statusCode >= 500) {
    logger.error('Unhandled server error', { ...logContext, stack: err.stack });
  } else if (statusCode >= 400) {
    logger.warn('Client error', logContext);
  }

  // ── Response ──────────────────────────────────────────────────────────────
  const responseBody = {
    success: false,
    code,
    message,
  };

  if (errors) {
    responseBody.errors = errors;
  }

  // Include stack trace in development only
  if (process.env.NODE_ENV === 'development' && statusCode >= 500) {
    responseBody.stack = err.stack;
  }

  return res.status(statusCode).json(responseBody);
};

/**
 * 404 Not Found handler — register before errorHandler.
 */
const notFound = (req, res, next) => {
  const err = new Error(`Route not found: ${req.method} ${req.originalUrl}`);
  err.statusCode = 404;
  err.code = 'NOT_FOUND';
  err.isOperational = true;
  next(err);
};

module.exports = { errorHandler, notFound };
