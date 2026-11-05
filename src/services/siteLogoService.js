'use strict';

const path = require('path');
const { sequelize } = require('../models');
const repository = require('../repositories/siteLogoRepository');
const { createAuditLog } = require('../middlewares/auditLog');
const logger = require('../utils/logger');

/**
 * Site Logo — the logo the whole site shows. A Platform Admin uploads JPG / PNG / GIF images
 * (stored as bytea in Postgres), and activates one; at most one is active at a time.
 */

const MAX_LOGO_BYTES = 5 * 1024 * 1024; // 5 MB

// extension -> { mime, signature check on the real bytes }
const TYPES = {
  '.jpg': { mime: 'image/jpeg', check: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  '.jpeg': { mime: 'image/jpeg', check: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  '.png': {
    mime: 'image/png',
    check: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  '.gif': {
    mime: 'image/gif',
    check: (b) => b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1')),
  },
};

const httpError = (message, statusCode) => Object.assign(new Error(message), { statusCode });

/**
 * Validates an uploaded multer memory file (extension, declared mimetype AND magic bytes).
 * @returns {{ mime: string }} the canonical mime type to store
 * @throws {Error} with statusCode 422 (415-style rejections are reported as 422 per contract)
 */
const validateLogoFile = (file) => {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    throw httpError('Please choose an image file to upload (field name "file").', 422);
  }
  if (file.buffer.length > MAX_LOGO_BYTES) {
    throw httpError('Logo is too large. Maximum allowed size is 5 MB.', 413);
  }
  const ext = path.extname(file.originalname || '').toLowerCase();
  const type = TYPES[ext];
  const declared = String(file.mimetype || '').toLowerCase();
  const declaredOk = type && (declared === type.mime || (type.mime === 'image/jpeg' && declared === 'image/jpg'));
  if (!type || !declaredOk || !type.check(file.buffer)) {
    throw httpError('Invalid logo file. Only JPG, PNG and GIF images are allowed (SVG and other formats are not accepted).', 422);
  }
  return { mime: type.mime };
};

const imagePathFor = (id) => `/system-settings/logos/${id}/image`;

const toItem = (row) => {
  const r = typeof row.toJSON === 'function' ? row.toJSON() : row;
  return {
    id: r.id,
    file_name: r.file_name,
    mime_type: r.mime_type,
    file_size: r.file_size,
    is_active: r.is_active,
    created_at: r.created_at,
    uploaded_by_name: r.uploader ? r.uploader.full_name : null,
    image_path: imagePathFor(r.id),
  };
};

/** Public: the active logo or null. */
const getActiveLogo = async () => {
  const row = await repository.findActive();
  if (!row) return null;
  return { id: row.id, image_path: imagePathFor(row.id), file_name: row.file_name, updated_at: row.updated_at };
};

const listLogos = async () => (await repository.findAll()).map(toItem);

const uploadLogo = async (file, userId, ipAddress) => {
  const { mime } = validateLogoFile(file);
  const created = await repository.create({
    file_name: path.basename(file.originalname).slice(0, 255),
    mime_type: mime,
    file_size: file.buffer.length,
    image_data: file.buffer,
    is_active: false,
    uploaded_by: userId || null,
  });
  createAuditLog(userId, 'CREATE', 'site_logos', created.id, null,
    { file_name: created.file_name, file_size: created.file_size }, ipAddress);
  logger.info('Site logo uploaded', { userId, logoId: created.id });
  return toItem(await repository.findById(created.id));
};

const activateLogo = async (id, userId, ipAddress) => {
  const logoId = parseInt(id, 10);
  if (!Number.isInteger(logoId) || logoId < 1) throw httpError('Logo not found.', 404);

  const previous = await repository.findActive();
  await sequelize.transaction(async (transaction) => {
    if (!(await repository.exists(logoId, transaction))) throw httpError('Logo not found.', 404);
    await repository.deactivateAll(transaction);
    await repository.activateById(logoId, transaction);
  });

  createAuditLog(userId, 'UPDATE', 'site_logos', logoId,
    { active_logo_id: previous ? previous.id : null }, { active_logo_id: logoId }, ipAddress);
  logger.info('Site logo activated', { userId, logoId });
  return toItem(await repository.findById(logoId));
};

/** Public: bytes + mime for streaming, or null. */
const getLogoImage = async (id) => {
  const logoId = parseInt(id, 10);
  if (!Number.isInteger(logoId) || logoId < 1) return null;
  const row = await repository.findImageById(logoId);
  return row ? { data: row.image_data, mime_type: row.mime_type } : null;
};

module.exports = { MAX_LOGO_BYTES, validateLogoFile, getActiveLogo, listLogos, uploadLogo, activateLogo, getLogoImage };
