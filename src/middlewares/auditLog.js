'use strict';

const { AuditLog } = require('../models');
const logger = require('../utils/logger');

/**
 * Creates an audit log entry in the database.
 * This function is intentionally non-throwing — a failure to write an audit log
 * must never break the primary business operation.
 *
 * @param {number|null}  userId      - ID of the user performing the action
 * @param {string}       action      - Action performed (e.g. 'CREATE', 'UPDATE', 'DELETE', 'LOGIN')
 * @param {string}       entityType  - Name of the entity/table (e.g. 'employees', 'service_pos')
 * @param {number|null}  entityId    - Primary key of the affected record
 * @param {object|null}  oldValues   - Snapshot of data before the change
 * @param {object|null}  newValues   - Snapshot of data after the change
 * @param {string|null}  ipAddress   - IP address of the requester
 * @returns {Promise<void>}
 */
const createAuditLog = async (
  userId,
  action,
  entityType,
  entityId,
  oldValues = null,
  newValues = null,
  ipAddress = null
) => {
  try {
    await AuditLog.create({
      user_id: userId || null,
      action: String(action).toUpperCase().slice(0, 50),
      entity_type: String(entityType).slice(0, 50),
      entity_id: entityId || null,
      old_values: oldValues ? JSON.parse(JSON.stringify(oldValues)) : null,
      new_values: newValues ? JSON.parse(JSON.stringify(newValues)) : null,
      ip_address: ipAddress ? String(ipAddress).slice(0, 45) : null,
    });
  } catch (error) {
    // Log the failure but never propagate — audit is a side effect
    logger.error('Failed to write audit log', {
      error: error.message,
      userId,
      action,
      entityType,
      entityId,
    });
  }
};

/**
 * Express middleware factory that automatically logs write operations.
 * Attach after authenticate() on mutating routes.
 *
 * @param {string} action      - Action label (e.g. 'CREATE', 'UPDATE', 'DELETE')
 * @param {string} entityType  - Entity type label
 * @param {Function} [getEntityId] - Optional fn(req, res) => number to extract entity id post-response
 * @returns {Function} Express middleware
 */
const auditMiddleware = (action, entityType, getEntityId) => {
  return (req, res, next) => {
    // Intercept the json method to capture the entity id from the response body
    const originalJson = res.json.bind(res);

    res.json = function (body) {
      res.locals.responseBody = body;
      return originalJson(body);
    };

    res.on('finish', async () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        let entityId = null;
        if (typeof getEntityId === 'function') {
          try {
            entityId = getEntityId(req, res);
          } catch (_) {
            // ignore
          }
        } else if (req.params && req.params.id) {
          entityId = parseInt(req.params.id, 10) || null;
        }

        const ipAddress =
          req.ip ||
          req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
          req.connection?.remoteAddress ||
          null;

        await createAuditLog(
          req.userId || null,
          action,
          entityType,
          entityId,
          null,
          null,
          ipAddress
        );
      }
    });

    next();
  };
};

/**
 * Helper to extract client IP address from a request object.
 * @param {import('express').Request} req
 * @returns {string|null}
 */
const getIpAddress = (req) => {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.ip ||
    req.connection?.remoteAddress ||
    null
  );
};

module.exports = {
  createAuditLog,
  auditMiddleware,
  getIpAddress,
};
