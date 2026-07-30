'use strict';

/**
 * Send a standardized success response.
 *
 * @param {import('express').Response} res
 * @param {*}      [data=null]        - Response payload.
 * @param {string} [message='Success'] - Human-readable message.
 * @param {number} [statusCode=200]   - HTTP status code.
 * @param {object} [meta=null]        - Optional pagination / extra metadata.
 */
function sendSuccess(res, data = null, message = 'Success', statusCode = 200, meta = null) {
  const body = {
    success: true,
    message,
    data,
  };

  if (meta !== null && typeof meta === 'object') {
    body.meta = meta;
  }

  return res.status(statusCode).json(body);
}

/**
 * Send a standardized error response.
 *
 * In production, a 500+ status is always accompanied by a generic message —
 * regardless of what the caller passed in — since most controller catch
 * blocks forward a raw error.message (which may be a Sequelize/Postgres/
 * filesystem error containing internal details: table/column names, file
 * paths, driver-level text) straight through to this function without an
 * environment check of their own. This mirrors the same redaction the
 * global error handler in app.js already applies to its own 500s, so an
 * unexpected internal error looks the same to API callers everywhere.
 * 4xx responses (validation, not-found, forbidden, etc.) are untouched —
 * those are intentional, already-safe, user-facing messages.
 *
 * @param {import('express').Response} res
 * @param {string} [message='An error occurred'] - Human-readable error message.
 * @param {number} [statusCode=500]              - HTTP status code.
 * @param {Array}  [errors=[]]                   - Validation / field-level errors.
 */
function sendError(res, message = 'An error occurred', statusCode = 500, errors = []) {
  const isProdInternalError = process.env.NODE_ENV === 'production' && statusCode >= 500;
  const body = {
    success: false,
    message: isProdInternalError ? 'An internal server error occurred.' : message,
  };

  if (Array.isArray(errors) && errors.length > 0) {
    body.errors = errors;
  }

  return res.status(statusCode).json(body);
}

/**
 * Send a 201 Created response.
 *
 * @param {import('express').Response} res
 * @param {*}      data
 * @param {string} [message='Resource created successfully']
 */
function sendCreated(res, data, message = 'Resource created successfully') {
  return sendSuccess(res, data, message, 201);
}

/**
 * Send a 204 No Content response (no body).
 *
 * @param {import('express').Response} res
 */
function sendNoContent(res) {
  return res.status(204).send();
}

/**
 * Send a paginated list response.
 *
 * @param {import('express').Response} res
 * @param {Array}  data   - Array of records for this page.
 * @param {object} meta   - Pagination metadata from getPaginationMeta().
 * @param {string} [message='Data fetched successfully']
 */
function sendPaginated(res, data, meta, message = 'Data fetched successfully') {
  return sendSuccess(res, data, message, 200, meta);
}

/**
 * Send a 401 Unauthorized response.
 *
 * @param {import('express').Response} res
 * @param {string} [message='Unauthorized']
 */
function sendUnauthorized(res, message = 'Unauthorized. Please log in.') {
  return sendError(res, message, 401);
}

/**
 * Send a 403 Forbidden response.
 *
 * @param {import('express').Response} res
 * @param {string} [message='Forbidden']
 */
function sendForbidden(res, message = 'You do not have permission to perform this action.') {
  return sendError(res, message, 403);
}

/**
 * Send a 404 Not Found response.
 *
 * @param {import('express').Response} res
 * @param {string} [resource='Resource']
 */
function sendNotFound(res, resource = 'Resource') {
  return sendError(res, `${resource} not found.`, 404);
}

/**
 * Send a 422 Unprocessable Entity response for validation failures.
 *
 * @param {import('express').Response} res
 * @param {string} [message='Validation failed']
 * @param {Array}  [errors=[]]
 */
function sendValidationError(res, message = 'Validation failed', errors = []) {
  return sendError(res, message, 422, errors);
}

module.exports = {
  sendSuccess,
  sendError,
  sendCreated,
  sendNoContent,
  sendPaginated,
  sendUnauthorized,
  sendForbidden,
  sendNotFound,
  sendValidationError,
};
