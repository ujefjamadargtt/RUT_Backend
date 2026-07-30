'use strict';

const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const notificationController = require('../controllers/notificationController');

/**
 * @swagger
 * tags:
 *   name: Notifications
 *   description: In-app notification management for the authenticated user
 */

/**
 * @swagger
 * /notifications:
 *   get:
 *     summary: Get paginated notifications for the current user
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: is_read
 *         schema: { type: string, enum: ['true', 'false'] }
 *         description: Filter by read status. Omit to return all.
 *       - in: query
 *         name: type
 *         schema: { type: string }
 *         description: Filter by notification type (info, warning, success, error)
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [ASC, DESC] }
 *         description: Sort order by creation date. Defaults to DESC (newest first).
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *     responses:
 *       200:
 *         description: Paginated notification list with unread_count in meta
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:  { type: boolean }
 *                 message:  { type: string }
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:         { type: integer }
 *                       title:      { type: string }
 *                       message:    { type: string }
 *                       type:       { type: string }
 *                       is_read:    { type: boolean }
 *                       created_at: { type: string, format: date-time }
 *                 meta:
 *                   type: object
 *                   properties:
 *                     total:        { type: integer }
 *                     page:         { type: integer }
 *                     limit:        { type: integer }
 *                     totalPages:   { type: integer }
 *                     hasNext:      { type: boolean }
 *                     hasPrev:      { type: boolean }
 *                     unread_count: { type: integer }
 *       401:
 *         description: Unauthorized
 */
router.get('/', authenticate, notificationController.getUserNotifications);

/**
 * @swagger
 * /notifications/mark-all-read:
 *   put:
 *     summary: Mark all unread notifications as read
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Count of notifications updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 message: { type: string }
 *                 data:
 *                   type: object
 *                   properties:
 *                     updated: { type: integer }
 *       401:
 *         description: Unauthorized
 */
// NOTE: /mark-all-read MUST be declared before /:id/read to avoid Express
// matching the literal string "mark-all-read" as an :id parameter.
router.put('/mark-all-read', authenticate, notificationController.markAllRead);

/**
 * @swagger
 * /notifications/{id}/read:
 *   put:
 *     summary: Mark a specific notification as read
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Updated notification object
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Notification not found or does not belong to user
 */
router.put('/:id/read', authenticate, notificationController.markAsRead);

/**
 * @swagger
 * /notifications/{id}:
 *   delete:
 *     summary: Delete a notification
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       204:
 *         description: Notification deleted — no content returned
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Notification not found or does not belong to user
 */
router.delete('/:id', authenticate, notificationController.deleteNotification);

module.exports = router;
