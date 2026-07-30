'use strict';

const notificationRepo = require('../repositories/notificationRepository');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const logger = require('../utils/logger');

/**
 * Notification Service
 */

/**
 * Get paginated notifications for the authenticated user.
 *
 * @param {number} userId
 * @param {object} query - req.query
 * @returns {Promise<{ data: object[], meta: object, unread_count: number }>}
 */
async function getUserNotifications(userId, query) {
  const { page, limit, offset } = getPaginationParams(query);

  // Parse is_read: accept 'true' | 'false' | undefined
  let isRead;
  if (query.is_read === 'true') isRead = true;
  else if (query.is_read === 'false') isRead = false;
  // else leave undefined → return all

  const sortOrder =
    query.sortOrder && query.sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const { rows, count } = await notificationRepo.findByUserId(userId, {
    isRead,
    type: query.type || undefined,
    limit,
    offset,
    sortOrder,
  });

  const meta = getPaginationMeta(count, page, limit);
  const unreadCount = await notificationRepo.getUnreadCount(userId);

  return { data: rows, meta, unread_count: unreadCount };
}

/**
 * Mark a single notification as read.
 * Validates ownership before updating.
 *
 * @param {number} notificationId
 * @param {number} userId
 * @returns {Promise<void>}
 */
async function markAsRead(notificationId, userId) {
  const notification = await notificationRepo.findByIdAndUser(notificationId, userId);
  if (!notification) {
    const err = new Error('Notification not found.');
    err.statusCode = 404;
    throw err;
  }

  if (notification.is_read) {
    // Already read — treat as a no-op, not an error
    return notification;
  }

  await notificationRepo.markAsRead(notificationId, userId);
  logger.info('Notification marked as read', { notificationId, userId });

  return { ...notification.toJSON(), is_read: true };
}

/**
 * Mark all notifications for a user as read.
 *
 * @param {number} userId
 * @returns {Promise<{ updated: number }>}
 */
async function markAllRead(userId) {
  const [updated] = await notificationRepo.markAllRead(userId);
  logger.info('All notifications marked as read', { userId, updated });
  return { updated };
}

/**
 * Delete a single notification (ownership enforced).
 *
 * @param {number} notificationId
 * @param {number} userId
 * @returns {Promise<void>}
 */
async function deleteNotification(notificationId, userId) {
  const notification = await notificationRepo.findByIdAndUser(notificationId, userId);
  if (!notification) {
    const err = new Error('Notification not found.');
    err.statusCode = 404;
    throw err;
  }

  await notificationRepo.deleteById(notificationId, userId);
  logger.info('Notification deleted', { notificationId, userId });
}

/**
 * Create a notification programmatically (called from other services).
 *
 * @param {object} payload
 * @param {number} payload.user_id
 * @param {string} payload.title
 * @param {string} payload.message
 * @param {string} [payload.type]   - info | warning | success | error
 * @returns {Promise<object>}
 */
async function createNotification({ user_id, title, message, type = 'info' }) {
  if (!user_id || !title || !message) {
    const err = new Error('user_id, title, and message are required to create a notification.');
    err.statusCode = 422;
    throw err;
  }

  const notification = await notificationRepo.create({ user_id, title, message, type });
  logger.info('Notification created', { notificationId: notification.id, user_id });
  return notification;
}

/**
 * Get the unread count for a user (used by auth endpoints to embed in token refresh).
 *
 * @param {number} userId
 * @returns {Promise<number>}
 */
async function getUnreadCount(userId) {
  return notificationRepo.getUnreadCount(userId);
}

module.exports = {
  getUserNotifications,
  markAsRead,
  markAllRead,
  deleteNotification,
  createNotification,
  getUnreadCount,
};
