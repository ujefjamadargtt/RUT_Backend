'use strict';

const { Router } = require('express');
const authController = require('../controllers/authController');
const authenticate = require('../middlewares/auth');
const { validate } = require('../middlewares/validateRequest');
const { authLimiter } = require('../middlewares/rateLimiters');
const {
  loginSchema,
  microsoftLoginSchema,
  selectRoleSchema,
  switchRoleSchema,
  refreshTokenSchema,
  directChangePasswordSchema,
  forgotPasswordSchema,
  verifyOtpSchema,
  resendOtpSchema,
  resetPasswordSchema,
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
 *     summary: Authenticate an Employee (Role-Based Login)
 *     description: |
 *       Validates credentials against Employee Master. An Employee holding
 *       exactly ONE active role is logged in directly, same as before. An
 *       Employee holding MULTIPLE active roles does NOT get tokens yet —
 *       the response instead carries `requiresRoleSelection: true`, the
 *       list of roles to choose from, and a short-lived `loginTicket`
 *       (credentials are already verified at this point). The frontend
 *       must prompt the user to pick a role and complete login via
 *       POST /auth/select-role with that `loginTicket` and the chosen
 *       `roleId`.
 *
 *       Neither response carries mapped Business Units — fetch those
 *       separately via GET /employees/{id}/business-units using the
 *       employee id from this response.
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
 *         description: Login successful, OR role selection required (see requiresRoleSelection)
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - type: object
 *                   description: Exactly one active role — logged in directly
 *                   properties:
 *                     success: { type: boolean, example: true }
 *                     message: { type: string, example: Login successful. }
 *                     data:
 *                       type: object
 *                       properties:
 *                         accessToken: { type: string }
 *                         refreshToken: { type: string }
 *                         expiresIn: { type: string, example: "15m" }
 *                         employee: { type: object }
 *                         roles: { type: array, items: { type: object } }
 *                         forms: { type: object }
 *                 - type: object
 *                   description: More than one active role — role selection required
 *                   properties:
 *                     success: { type: boolean, example: true }
 *                     message: { type: string, example: Login successful. }
 *                     data:
 *                       type: object
 *                       properties:
 *                         requiresRoleSelection: { type: boolean, example: true }
 *                         loginTicket: { type: string, description: Short-lived (5m); pass to POST /auth/select-role }
 *                         roles: { type: array, items: { type: object } }
 *       401:
 *         description: Invalid credentials (email resolved to an account, but the password was wrong)
 *       403:
 *         description: Account or role is inactive
 *       404:
 *         description: Email ID is not registered
 *       422:
 *         description: Validation error
 */
router.post('/login', authLimiter, validate(loginSchema), authController.login);

/**
 * @swagger
 * /auth/microsoft:
 *   post:
 *     summary: Authenticate an Employee via Microsoft Entra ID SSO
 *     description: |
 *       The frontend completes an Authorization Code + PKCE sign-in via MSAL
 *       entirely client-side, then sends ONLY the resulting Microsoft ID
 *       token here. The backend verifies its signature (against Microsoft's
 *       JWKS), issuer, audience, expiration, and tenant ID before trusting
 *       any claim from it — email/name/role are never accepted from the
 *       request body itself.
 *
 *       Once the verified email resolves to an existing Employee, behavior
 *       is IDENTICAL to POST /auth/login from that point on: an Employee
 *       holding exactly ONE active role logs in directly; an Employee
 *       holding MULTIPLE active roles gets `requiresRoleSelection: true`
 *       instead, completed via POST /auth/select-role. Microsoft SSO never
 *       auto-creates an Employee — an unrecognised email is rejected the
 *       same way an unregistered email is on the password login endpoint.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [idToken]
 *             properties:
 *               idToken:
 *                 type: string
 *                 description: Microsoft Entra ID ID token obtained by the frontend via MSAL.
 *     responses:
 *       200:
 *         description: Login successful, OR role selection required (see requiresRoleSelection) — same response shape as POST /auth/login
 *       401:
 *         description: Invalid, expired, or wrong-tenant Microsoft token
 *       403:
 *         description: Account or role is inactive
 *       404:
 *         description: Email ID is not registered
 *       422:
 *         description: Validation error (missing idToken)
 *       503:
 *         description: Microsoft SSO is not configured on this server
 */
router.post('/microsoft', authLimiter, validate(microsoftLoginSchema), authController.loginWithMicrosoft);

/**
 * @swagger
 * /auth/select-role:
 *   post:
 *     summary: Complete Role-Based Login by picking one of several active roles
 *     description: |
 *       Exchanges the `loginTicket` from a login() response that carried
 *       `requiresRoleSelection: true`, plus the chosen `roleId`, for a real
 *       access/refresh token pair scoped to ONLY that role.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [loginTicket, roleId]
 *             properties:
 *               loginTicket: { type: string }
 *               roleId: { type: integer }
 *     responses:
 *       200:
 *         description: Login successful
 *       401:
 *         description: Invalid or expired login ticket
 *       403:
 *         description: Account inactive, or the role is no longer available for this account
 *       422:
 *         description: Validation error
 */
router.post('/select-role', authLimiter, validate(selectRoleSchema), authController.selectRole);

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

/**
 * @swagger
 * /auth/forgot-password:
 *   post:
 *     summary: Request a password reset OTP (User or Employee)
 *     description: |
 *       Supports both User and Employee accounts — the backend resolves
 *       which one(s) the submitted email belongs to using the same shared
 *       logic as /auth/login. `loginType` is OPTIONAL, required only when
 *       the email is registered as both (returns `requiresUserTypeSelection`
 *       otherwise). A 6-digit OTP, valid for 5 minutes, is emailed on success.
 *
 *       IMPORTANT: the success response includes the RESOLVED `loginType`
 *       (there is no `data` envelope on this endpoint). The frontend MUST
 *       store this value and send it back verbatim in /auth/verify-otp and
 *       /auth/reset-password — those two endpoints no longer re-resolve or
 *       search both tables; they trust and validate against exactly the
 *       `loginType` this endpoint returned.
 *
 *       Unlike a typical forgot-password flow, this API explicitly discloses
 *       when an email is not registered (`404 Email ID is not registered.`)
 *       rather than returning a generic response — a deliberate product
 *       requirement.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: abc@gtt.com
 *               loginType:
 *                 type: string
 *                 enum: [user, employee]
 *                 description: Optional — required only when the email resolves to both a User and an Employee.
 *     responses:
 *       200:
 *         description: OTP sent, OR account-type disambiguation required
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - type: object
 *                   description: OTP sent — loginType is the resolved account type; store it for /verify-otp and /reset-password.
 *                   properties:
 *                     success: { type: boolean, example: true }
 *                     message: { type: string, example: OTP sent successfully. }
 *                     loginType: { type: string, enum: [user, employee], example: user }
 *                 - type: object
 *                   description: Ambiguous — email exists as both a User and an Employee, loginType was omitted
 *                   properties:
 *                     success: { type: boolean, example: false }
 *                     requiresUserTypeSelection: { type: boolean, example: true }
 *                     message: { type: string, example: This email is associated with multiple account types. Please choose an account type. }
 *                     accountTypes:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           type: { type: string, example: user }
 *                           label: { type: string, example: User }
 *       404:
 *         description: Email ID is not registered
 *       429:
 *         description: An OTP was already sent recently — wait for the cooldown
 *       422:
 *         description: Validation error
 */
router.post('/forgot-password', authLimiter, validate(forgotPasswordSchema), authController.forgotPassword);

/**
 * @swagger
 * /auth/resend-otp:
 *   post:
 *     summary: Resend a password reset OTP
 *     description: |
 *       Expires the previous OTP (for this email + login type) and issues a
 *       new one. Enforced server-side with a 60-second cooldown since the
 *       last OTP was issued — the frontend's own resend-button timer is a
 *       UX convenience, not the actual security control. Same request/
 *       response contract as /auth/forgot-password, including returning the
 *       resolved `loginType` on success (no `data` envelope).
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               loginType:
 *                 type: string
 *                 enum: [user, employee]
 *     responses:
 *       200:
 *         description: OTP resent (with resolved loginType), OR account-type disambiguation required — same shape as /auth/forgot-password
 *       404:
 *         description: Email ID is not registered
 *       429:
 *         description: An OTP was already sent recently — wait for the cooldown
 *       422:
 *         description: Validation error
 */
router.post('/resend-otp', authLimiter, validate(resendOtpSchema), authController.resendOtp);

/**
 * @swagger
 * /auth/verify-otp:
 *   post:
 *     summary: Verify a password reset OTP
 *     description: |
 *       Checks the OTP exists for this email + loginType, is unexpired,
 *       unused, and within the 5-attempt limit. `loginType` is REQUIRED —
 *       the value returned by /auth/forgot-password (or /auth/resend-otp),
 *       sent back verbatim. This endpoint does NOT re-resolve or search
 *       both tables again; it scopes the check directly to the given
 *       loginType, which is also what guarantees a User's OTP can never
 *       verify against an Employee reset, or vice versa. On success, marks
 *       the OTP 'verified' — required before /auth/reset-password will accept it.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, otp, loginType]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               otp:
 *                 type: string
 *                 example: "582194"
 *               loginType:
 *                 type: string
 *                 enum: [user, employee]
 *     responses:
 *       200:
 *         description: OTP verified successfully
 *       400:
 *         description: Invalid or expired OTP, or maximum attempts exceeded
 *       422:
 *         description: Validation error (including a missing/invalid loginType)
 */
router.post('/verify-otp', authLimiter, validate(verifyOtpSchema), authController.verifyOtp);

/**
 * @swagger
 * /auth/reset-password:
 *   post:
 *     summary: Reset the password using a verified OTP
 *     description: |
 *       Requires /auth/verify-otp to have succeeded first for this email +
 *       loginType. `loginType` is REQUIRED — same OTP-to-account-type
 *       scoping as /auth/verify-otp, so only the specific User or Employee
 *       the OTP was issued for can ever be updated. Updates the password
 *       via the existing bcrypt-hashing update path, then marks the OTP
 *       'used' — it can never be reused.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, otp, password, confirmPassword, loginType]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               otp:
 *                 type: string
 *                 example: "582194"
 *               password:
 *                 type: string
 *                 format: password
 *                 minLength: 8
 *               confirmPassword:
 *                 type: string
 *                 format: password
 *               loginType:
 *                 type: string
 *                 enum: [user, employee]
 *     responses:
 *       200:
 *         description: Password reset successfully
 *       400:
 *         description: OTP not verified or has expired
 *       422:
 *         description: Validation error (including a missing/invalid loginType)
 */
router.post('/reset-password', authLimiter, validate(resetPasswordSchema), authController.resetPassword);

/**
 * @swagger
 * /auth/logout:
 *   post:
 *     summary: Log out (User or Employee)
 *     description: |
 *       Revokes the session matching the provided refresh token.
 *       authService.logout() already checks BOTH user_sessions and
 *       employee_sessions for a match (a leftover of the dynamic-login
 *       design), so this endpoint is deliberately PUBLIC — no Bearer
 *       token/authenticate middleware — rather than User-only. It
 *       previously required a valid User access token, which crashed with
 *       a 500 whenever an Employee called it (their access token has no
 *       `id` claim the User-only middleware expects). The refresh token
 *       itself is the only credential this operation needs or trusts; a
 *       stale/expired/absent access token has no bearing on whether the
 *       caller may revoke a session they hold the refresh token for.
 *       Idempotent — a refresh token that's already invalid or unknown
 *       still returns success.
 *     tags: [Auth]
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               refresh_token:
 *                 type: string
 *                 description: The refresh token to revoke (User or Employee). Omit to no-op.
 *     responses:
 *       200:
 *         description: Logged out successfully
 */
router.post('/logout', authController.logout);

// ─── Protected routes (require valid Bearer access token) ─────────────────────

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

/**
 * @swagger
 * /auth/switch-role:
 *   post:
 *     summary: Switch the authenticated employee's active role, without logging out
 *     description: |
 *       For an employee holding MULTIPLE active roles (e.g. Admin and BU
 *       Admin): switches the active role of the CURRENT session to another
 *       one of their own currently-active roles, and issues a fresh
 *       access/refresh token pair scoped to it — same session architecture
 *       as POST /auth/login and POST /auth/select-role, just triggered from
 *       an already-authenticated request instead of a pre-auth
 *       `loginTicket`. The employee is resolved from the caller's own
 *       Bearer access token, never from the request body, and `roleId`
 *       is validated server-side against THIS employee's own active roles
 *       — requesting a role not assigned to the caller, or no longer
 *       active, is rejected with 403. The prior session/refresh token is
 *       NOT revoked by a role switch (same as select-role); it simply
 *       expires or is revoked separately via /auth/logout.
 *
 *       BU (Business Unit) mapping is completely unaffected by a role
 *       switch — existing BU authorization/selection behavior for the new
 *       active role applies unchanged, same as any other login.
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [roleId]
 *             properties:
 *               roleId:
 *                 type: integer
 *                 description: Must be one of the caller's own currently active roles.
 *     responses:
 *       200:
 *         description: Role switched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Role switched successfully. }
 *                 data:
 *                   type: object
 *                   properties:
 *                     accessToken: { type: string }
 *                     refreshToken: { type: string }
 *                     expiresIn: { type: string, example: "15m" }
 *                     employee: { type: object }
 *                     roles: { type: array, items: { type: object } }
 *                     forms: { type: object }
 *       401:
 *         description: Missing or invalid access token
 *       403:
 *         description: Account is inactive, or the requested role is not assigned/active for this employee
 *       422:
 *         description: Validation error
 */
router.post('/switch-role', authLimiter, authenticate.authenticateIdentity, validate(switchRoleSchema), authController.switchRole);

/**
 * @swagger
 * /auth/change-password:
 *   put:
 *     summary: Directly change the authenticated User's or Employee's password
 *     description: |
 *       Supports BOTH User and Employee accounts through this one endpoint.
 *       No current-password check — this trusts the caller's already-verified
 *       access token (distinct from the separate /users/:id/change-password
 *       self-service endpoint, which does verify the old password).
 *
 *       The request body ONLY ever needs `newPassword`. The account to
 *       update (its id and whether it's a User or an Employee) is resolved
 *       entirely from the Bearer access token — a User access token or an
 *       Employee access token are both accepted here (they are distinguished
 *       by JWT audience), and whichever one is presented determines which
 *       table gets updated. Any `id`/`userType` sent in the request body is
 *       ignored; only the authenticated token's own identity is ever used,
 *       so an account can only ever change its own password.
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [newPassword]
 *             properties:
 *               newPassword:
 *                 type: string
 *                 format: password
 *                 minLength: 8
 *                 example: "NewPassword@123"
 *                 description: Must contain at least one uppercase letter, one lowercase letter, one digit, and one special character.
 *     responses:
 *       200:
 *         description: Password updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Password updated successfully. }
 *       401:
 *         description: Missing, invalid, or expired access token (User or Employee)
 *       404:
 *         description: Account no longer exists (e.g. deleted between token issue and this request)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: false }
 *                 message: { type: string, example: User not found. }
 *       422:
 *         description: Validation error (weak password) or an unresolvable account type
 */
router.put('/change-password', authLimiter, authenticate, validate(directChangePasswordSchema), authController.changePassword);

module.exports = router;
