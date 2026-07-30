'use strict';

const { Router } = require('express');
const authController = require('../controllers/authController');
const authenticate = require('../middlewares/auth');
const { validate } = require('../middlewares/validateRequest');
const { authLimiter } = require('../middlewares/rateLimiters');
const {
  loginSchema,
  refreshTokenSchema,
} = require('../validations/authValidation');

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: Authentication endpoints — login, logout, token refresh, and profile
 */

// ─── Public routes ────────────────────────────────────────────────────────────

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Authenticate a user
 *     description: |
 *       Validates credentials and returns a short-lived JWT access token
 *       and a long-lived refresh token. The refresh token is persisted in
 *       `user_sessions` so it can be revoked server-side.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: john.doe@example.com
 *               password:
 *                 type: string
 *                 format: password
 *                 minLength: 6
 *                 example: "Secret@123"
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Login successful.
 *                 data:
 *                   type: object
 *                   properties:
 *                     accessToken:
 *                       type: string
 *                     refreshToken:
 *                       type: string
 *                     expiresIn:
 *                       type: string
 *                       example: "15m"
 *                     user:
 *                       $ref: '#/components/schemas/UserProfile'
 *       401:
 *         description: Invalid credentials
 *       403:
 *         description: Account or role is inactive
 *       422:
 *         description: Validation error
 */
router.post('/login', authLimiter, validate(loginSchema), authController.login);

/**
 * @swagger
 * /auth/refresh-token:
 *   post:
 *     summary: Refresh the access token
 *     description: |
 *       Accepts a valid refresh token, verifies it against the session store,
 *       and returns a new access + refresh token pair (token rotation).
 *       The old refresh token is invalidated immediately.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refresh_token]
 *             properties:
 *               refresh_token:
 *                 type: string
 *     responses:
 *       200:
 *         description: Token refreshed successfully
 *       401:
 *         description: Refresh token is invalid, expired, or revoked
 *       422:
 *         description: Validation error
 */
router.post('/refresh-token', validate(refreshTokenSchema), authController.refreshToken);

// ─── Protected routes (require valid Bearer access token) ─────────────────────

/**
 * @swagger
 * /auth/logout:
 *   post:
 *     summary: Log out the current user
 *     description: |
 *       Revokes the session associated with the provided refresh token.
 *       Requires a valid Bearer access token in the Authorization header.
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               refresh_token:
 *                 type: string
 *                 description: The refresh token to revoke. Omit to simply clear the access context.
 *     responses:
 *       200:
 *         description: Logged out successfully
 *       401:
 *         description: Missing or invalid access token
 */
router.post('/logout', authenticate, authController.logout);

/**
 * @swagger
 * /auth/profile:
 *   get:
 *     summary: Get the authenticated user's profile
 *     description: |
 *       Returns the full profile of the currently authenticated user,
 *       including their role and linked employee record.
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Profile fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   $ref: '#/components/schemas/UserProfile'
 *       401:
 *         description: Missing or invalid access token
 *       404:
 *         description: User not found
 */
router.get('/profile', authenticate, authController.getProfile);

module.exports = router;
