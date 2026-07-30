'use strict';

const notificationService = require('../services/notificationService');
const {
  sendPaginated,
  sendSuccess,
  sendNoContent,
  sendError,
  sendNotFound,
} = require('../utils/response');
const logger = require('../utils/logger');

/**
 * Notification Controller
 * All endpoints operate on the authenticated user's own notifications.
 */

/**
 * GET /api/v1/notifications
 * Returns paginated notifications for the calling user.
 *
 * Query params:
 *   is_read  (true | false)
 *   type     (string)
 *   page, limit, sortOrder
 */
async function getUserNotifications(req, res, next) {
  try {
    const { data, meta, unread_count } = await notificationService.getUserNotifications(
      req.userId,
      req.query
    );

    // Embed unread_count into meta so the client can update the badge without a second request
    const enrichedMeta = { ...meta, unread_count };

    return sendPaginated(res, data, enrichedMeta, 'Notifications fetched successfully.');
  } catch (err) {
    logger.error('getUserNotifications error', { error: err.message, userId: req.userId });
    next(err);
  }
}

/**
 * PUT /api/v1/notifications/:id/read
 * Mark a specific notification as read (ownership enforced).
 */
async function markAsRead(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid notification ID.', 400);
    }

    const notification = await notificationService.markAsRead(id, req.userId);
    return sendSuccess(res, notification, 'Notification marked as read.');
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Notification');
    }
    logger.error('markAsRead error', { error: err.message, userId: req.userId });
    next(err);
  }
}

/**
 * PUT /api/v1/notifications/mark-all-read
 * Mark every unread notification for the calling user as read.
 */
async function markAllRead(req, res, next) {
  try {
    const { updated } = await notificationService.markAllRead(req.userId);
    return sendSuccess(
      res,
      { updated },
      updated > 0
        ? `${updated} notification(s) marked as read.`
        : 'No unread notifications to update.'
    );
  } catch (err) {
    logger.error('markAllRead error', { error: err.message, userId: req.userId });
    next(err);
  }
}

/**
 * DELETE /api/v1/notifications/:id
 * Permanently delete a notification (ownership enforced).
 */
async function deleteNotification(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return sendError(res, 'Invalid notification ID.', 400);
    }

    await notificationService.deleteNotification(id, req.userId);
    return sendNoContent(res);
  } catch (err) {
    if (err.statusCode === 404) {
      return sendNotFound(res, 'Notification');
    }
    logger.error('deleteNotification error', { error: err.message, userId: req.userId });
    next(err);
  }
}

module.exports = {
  getUserNotifications,
  markAsRead,
  markAllRead,
  deleteNotification,
};
