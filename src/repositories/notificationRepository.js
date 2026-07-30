'use strict';

const { Notification } = require('../models');
const { Op } = require('sequelize');

/**
 * Notification Repository
 * All operations are Sequelize ORM-based (no raw SQL needed for this module).
 */

/**
 * Find paginated notifications for a user, optionally filtered by read status.
 *
 * @param {number} userId
 * @param {object} options
 * @param {boolean|undefined} options.isRead   - true | false | undefined (all)
 * @param {string|undefined}  options.type     - Notification type filter
 * @param {number} options.limit
 * @param {number} options.offset
 * @param {string} options.sortOrder           - ASC | DESC
 * @returns {Promise<{ rows: Notification[], count: number }>}
 */
async function findByUserId(userId, { isRead, type, limit, offset, sortOrder = 'DESC' }) {
  const where = { user_id: userId };

  if (typeof isRead === 'boolean') {
    where.is_read = isRead;
  }
  if (type) {
    where.type = type;
  }

  return Notification.findAndCountAll({
    where,
    order: [['created_at', sortOrder]],
    limit,
    offset,
    attributes: ['id', 'title', 'message', 'type', 'is_read', 'created_at'],
  });
}

/**
 * Create a new notification.
 *
 * @param {object} payload
 * @param {number} payload.user_id
 * @param {string} payload.title
 * @param {string} payload.message
 * @param {string} [payload.type]
 * @returns {Promise<Notification>}
 */
async function create(payload) {
  return Notification.create({
    user_id: payload.user_id,
    title: payload.title,
    message: payload.message,
    type: payload.type || 'info',
    is_read: false,
  });
}

/**
 * Find a single notification by ID and user (ensures ownership).
 *
 * @param {number} id
 * @param {number} userId
 * @returns {Promise<Notification|null>}
 */
async function findByIdAndUser(id, userId) {
  return Notification.findOne({
    where: { id, user_id: userId },
  });
}

/**
 * Mark a single notification as read.
 *
 * @param {number} id
 * @param {number} userId
 * @returns {Promise<[number]>} - Number of rows updated
 */
async function markAsRead(id, userId) {
  return Notification.update(
    { is_read: true },
    { where: { id, user_id: userId } }
  );
}

/**
 * Mark all notifications for a user as read.
 *
 * @param {number} userId
 * @returns {Promise<[number]>} - Number of rows updated
 */
async function markAllRead(userId) {
  return Notification.update(
    { is_read: true },
    { where: { user_id: userId, is_read: false } }
  );
}

/**
 * Delete a notification (ownership-checked).
 *
 * @param {number} id
 * @param {number} userId
 * @returns {Promise<number>} - Number of rows deleted
 */
async function deleteById(id, userId) {
  return Notification.destroy({
    where: { id, user_id: userId },
  });
}

/**
 * Count unread notifications for a user.
 *
 * @param {number} userId
 * @returns {Promise<number>}
 */
async function getUnreadCount(userId) {
  return Notification.count({
    where: { user_id: userId, is_read: false },
  });
}

/**
 * Bulk create notifications (e.g., system-wide announcements).
 *
 * @param {object[]} notifications - Array of { user_id, title, message, type }
 * @returns {Promise<Notification[]>}
 */
async function bulkCreate(notifications) {
  return Notification.bulkCreate(
    notifications.map((n) => ({
      user_id: n.user_id,
      title: n.title,
      message: n.message,
      type: n.type || 'info',
      is_read: false,
    })),
    { returning: true }
  );
}

/**
 * Delete all read notifications older than the given date for a user.
 * Useful for housekeeping.
 *
 * @param {number} userId
 * @param {Date}   before
 * @returns {Promise<number>}
 */
async function deleteReadBefore(userId, before) {
  return Notification.destroy({
    where: {
      user_id: userId,
      is_read: true,
      created_at: { [Op.lt]: before },
    },
  });
}

module.exports = {
  findByUserId,
  create,
  findByIdAndUser,
  markAsRead,
  markAllRead,
  deleteById,
  getUnreadCount,
  bulkCreate,
  deleteReadBefore,
};
