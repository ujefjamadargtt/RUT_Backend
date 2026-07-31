'use strict';

const { Op, literal, QueryTypes } = require('sequelize');
const { sequelize, PasswordResetOtp, PasswordResetHistory } = require('../models');

/**
 * Password Reset Repository
 * Raw database access for password_reset_otps / password_reset_history —
 * no OTP generation/hashing/comparison logic lives here.
 *
 * IMPORTANT — every expiry/cooldown time comparison here is done via
 * Postgres's own NOW(), never by pulling a timestamp into JS and comparing
 * against `new Date()`. This project runs two separate Sequelize instances
 * in the same process (src/config/database.js and src/models/index.js),
 * each registering its own `pg` global timestamp type-parser with a
 * different `timezone` option — whichever loads last wins for BOTH
 * instances process-wide. Empirically (tested directly against this DB)
 * this currently makes every "timestamp without time zone" column read
 * back ~5.5h off from its true value once hydrated into a JS Date via a
 * model attribute — confirmed this pre-existing bug also silently affects
 * `user_sessions.expires_at` (a 7-day session actually expires ~6.77 days
 * in). Comparing entirely inside SQL sidesteps it: NOW() and the stored
 * value are both subject to the exact same (mis)interpretation, so the
 * comparison itself stays correct even though neither individual value
 * would print correctly if pulled into JS. This is a workaround scoped to
 * this feature only — fixing the underlying dual-instance issue project-
 * wide is a separate, much larger change outside this task's scope.
 */

/**
 * Insert a new OTP row. `expiresInMinutes` is computed entirely in
 * Postgres (NOW() + INTERVAL) — see module doc for why.
 * @param {object} data
 * @param {number} expiresInMinutes
 * @returns {Promise<PasswordResetOtp>}
 */
const createOtp = async (data, expiresInMinutes) => {
  return PasswordResetOtp.create({
    ...data,
    expires_at: literal(`NOW() + INTERVAL '${parseInt(expiresInMinutes, 10)} minutes'`),
  });
};

/**
 * Whether an OTP was issued for this email + login_type within the last
 * `cooldownSeconds` — pure SQL boolean check, the basis of the 60-second
 * resend cooldown (applied to both forgot-password and resend-otp).
 * Scoped per login_type: requesting a User OTP doesn't block an
 * independent Employee OTP request for the same email, and vice versa.
 * @param {string} email
 * @param {string} purpose
 * @param {string} loginType - 'user' | 'employee'
 * @param {number} cooldownSeconds
 * @returns {Promise<boolean>}
 */
const hasRecentOtp = async (email, purpose, loginType, cooldownSeconds) => {
  const rows = await sequelize.query(
    `SELECT EXISTS (
       SELECT 1 FROM password_reset_otps
       WHERE email = :email AND purpose = :purpose AND login_type = :loginType
         AND created_at > NOW() - INTERVAL '${parseInt(cooldownSeconds, 10)} seconds'
     ) AS active`,
    { replacements: { email: email.toLowerCase(), purpose, loginType }, type: QueryTypes.SELECT }
  );
  return rows[0].active === true;
};

/**
 * Flip every 'pending' row for an email (optionally scoped to one
 * login_type) whose expires_at has already elapsed to 'expired' — a lazy,
 * on-read cleanup instead of a cron sweep, condition evaluated entirely in
 * SQL.
 * @param {string} email
 * @param {string} purpose
 * @param {string} [loginType] - 'user' | 'employee'; omit to affect both
 * @returns {Promise<void>}
 */
const expireElapsedPending = async (email, purpose, loginType) => {
  const where = { email: email.toLowerCase(), purpose };
  if (loginType) where.login_type = loginType;
  await PasswordResetOtp.update(
    { status: 'expired' },
    { where: { ...where, status: 'pending', [Op.and]: [literal('expires_at <= NOW()')] } }
  );
};

/**
 * Every 'pending', NOT-YET-EXPIRED OTP row for an email + login_type
 * (expires_at > NOW() checked in SQL), newest first. Callers should run
 * expireElapsedPending() first so stale rows are already flipped to
 * 'expired' (and therefore excluded here for that reason too, not just the
 * expires_at filter).
 *
 * login_type is REQUIRED here — this is the enforcement point for "never
 * allow a User OTP to verify against an Employee reset, or vice versa"
 * (Security requirement): an OTP row only ever matches when its email AND
 * login_type both agree with what the caller is verifying against.
 *
 * @param {string} email
 * @param {string} purpose
 * @param {string} loginType - 'user' | 'employee'
 * @returns {Promise<PasswordResetOtp[]>}
 */
const findLivePendingByEmail = async (email, purpose, loginType) => {
  return PasswordResetOtp.findAll({
    where: {
      email: email.toLowerCase(),
      purpose,
      login_type: loginType,
      status: 'pending',
      [Op.and]: [literal('expires_at > NOW()')],
    },
    order: [['created_at', 'DESC']],
  });
};

/**
 * The most recently 'verified', still-unexpired OTP row for an email +
 * login_type — reset-password validates against this row. Same
 * login_type-scoping rationale as findLivePendingByEmail.
 * @param {string} email
 * @param {string} purpose
 * @param {string} loginType - 'user' | 'employee'
 * @returns {Promise<PasswordResetOtp|null>}
 */
const findVerifiedLiveByEmail = async (email, purpose, loginType) => {
  return PasswordResetOtp.findOne({
    where: {
      email: email.toLowerCase(),
      purpose,
      login_type: loginType,
      status: 'verified',
      [Op.and]: [literal('expires_at > NOW()')],
    },
    order: [['created_at', 'DESC']],
  });
};

/**
 * Expire every currently-'pending' OTP row for an email + login_type —
 * called right before issuing a new OTP (send or resend) so only the
 * newest one for that specific account type is ever usable. Scoped to
 * login_type so requesting a User OTP never expires a still-pending
 * Employee OTP for the same email, and vice versa.
 * @param {string} email
 * @param {string} purpose
 * @param {string} loginType - 'user' | 'employee'
 * @returns {Promise<number>} rows updated
 */
const expirePendingByEmail = async (email, purpose, loginType) => {
  const [count] = await PasswordResetOtp.update(
    { status: 'expired' },
    { where: { email: email.toLowerCase(), purpose, login_type: loginType, status: 'pending' } }
  );
  return count;
};

/**
 * Update an OTP row by primary key. Pass `literal('NOW()')` for any
 * timestamp field being set (verified_at/used_at) — see module doc.
 * @param {number} id
 * @param {object} data
 * @returns {Promise<PasswordResetOtp|null>}
 */
const updateOtpById = async (id, data) => {
  const otp = await PasswordResetOtp.findByPk(id);
  if (!otp) return null;
  return otp.update(data);
};

/**
 * Append a row to the password reset audit trail. Always succeeds even for
 * an email that resolved to no account (user_id/employee_id/company_id all
 * null) — the point is an auditable trail of every attempt, without ever
 * revealing account existence to the caller.
 * @param {object} data
 * @returns {Promise<PasswordResetHistory>}
 */
const logHistory = async (data) => {
  return PasswordResetHistory.create(data);
};

module.exports = {
  createOtp,
  hasRecentOtp,
  expireElapsedPending,
  findLivePendingByEmail,
  findVerifiedLiveByEmail,
  expirePendingByEmail,
  updateOtpById,
  logHistory,
};
