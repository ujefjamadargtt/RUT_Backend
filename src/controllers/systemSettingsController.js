'use strict';

const monthlyCapService = require('../services/monthlyCapService');
const siteLogoService = require('../services/siteLogoService');
const { getIpAddress } = require('../middlewares/auditLog');
const { sendSuccess, sendError, sendCreated } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * GET /system-settings/monthly-cap — any authenticated user (the frontend
 * reads the cap from here instead of hard-coding it). Optional ?month=&year=
 * adds `cap_for_month` (the newest synced cap for that month across Business Units; the latest
 * setting if never synced) and `cap_for_employee_month` (the cap THIS caller's own synced
 * timesheets for that month used; the latest setting if they have none) — employee-facing
 * screens should show the latter.
 */
const getMonthlyCap = async (req, res, next) => {
  try {
    const data = await monthlyCapService.getCapSetting();
    const month = parseInt(req.query.month, 10);
    const year = parseInt(req.query.year, 10);
    const hasPeriod = month >= 1 && month <= 12 && year >= 2000;
    data.cap_for_month = hasPeriod
      ? await monthlyCapService.getCapForMonth(month, year)
      : data.monthly_cap_hours;
    data.cap_for_employee_month = hasPeriod
      ? await monthlyCapService.getCapForEmployeeMonth(req.employeeId, month, year)
      : data.monthly_cap_hours;
    return sendSuccess(res, data, 'Monthly cap hours fetched successfully.');
  } catch (err) {
    logger.error('systemSettings getMonthlyCap error', { error: err.message, userId: req.userId });
    next(err);
  }
};

/**
 * PUT /system-settings/monthly-cap — Admin only (see route).
 */
const updateMonthlyCap = async (req, res, next) => {
  try {
    const data = await monthlyCapService.setCurrentCap(
      req.body.monthly_cap_hours,
      req.userId,
      getIpAddress(req)
    );
    return sendSuccess(
      res,
      data,
      'Monthly cap hours updated. It applies to syncs/imports run from now on; already-synced months keep their cap until re-synced.'
    );
  } catch (err) {
    if (err.statusCode) return sendError(res, err.message, err.statusCode);
    logger.error('systemSettings updateMonthlyCap error', { error: err.message, userId: req.userId });
    next(err);
  }
};

const handleErr = (res, next, label, req, err) => {
  if (err.statusCode) return sendError(res, err.message, err.statusCode);
  logger.error('systemSettings ' + label + ' error', { error: err.message, userId: req.userId });
  return next(err);
};

/** GET /system-settings/site-logo — PUBLIC (login page). data is null when no logo is active. */
const getSiteLogo = async (req, res, next) => {
  try {
    const data = await siteLogoService.getActiveLogo();
    return sendSuccess(res, data, 'Site logo fetched successfully.');
  } catch (err) { return handleErr(res, next, 'getSiteLogo', req, err); }
};

/** GET /system-settings/logos — Platform Admin only. */
const listLogos = async (req, res, next) => {
  try {
    return sendSuccess(res, await siteLogoService.listLogos(), 'Logos fetched successfully.');
  } catch (err) { return handleErr(res, next, 'listLogos', req, err); }
};

/** POST /system-settings/logos — Platform Admin only (multipart, field "file"). */
const uploadLogo = async (req, res, next) => {
  try {
    const data = await siteLogoService.uploadLogo(req.file, req.employeeId || req.userId, getIpAddress(req));
    return sendCreated(res, data, 'Logo uploaded successfully. Select it to make it the site logo.');
  } catch (err) { return handleErr(res, next, 'uploadLogo', req, err); }
};

/** PUT /system-settings/logos/:id/activate — Platform Admin only. */
const activateLogo = async (req, res, next) => {
  try {
    const data = await siteLogoService.activateLogo(req.params.id, req.employeeId || req.userId, getIpAddress(req));
    return sendSuccess(res, data, 'Site logo updated successfully.');
  } catch (err) { return handleErr(res, next, 'activateLogo', req, err); }
};

/** GET /system-settings/logos/:id/image — PUBLIC; streams the bytes. */
const getLogoImage = async (req, res, next) => {
  try {
    const img = await siteLogoService.getLogoImage(req.params.id);
    if (!img) return sendError(res, 'Logo not found.', 404);
    res.set({
      'Content-Type': img.mime_type,
      'Content-Length': img.data.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    return res.status(200).end(img.data);
  } catch (err) { return handleErr(res, next, 'getLogoImage', req, err); }
};

module.exports = {
  getMonthlyCap,
  updateMonthlyCap,
  getSiteLogo,
  listLogos,
  uploadLogo,
  activateLogo,
  getLogoImage,
};
