'use strict';

const logger = require('../utils/logger');

/**
 * Company-scoping gate. Runs as the tail of authenticate() (see auth.js) so
 * it reaches every authenticated route without touching any of the 135+
 * per-route authenticate() call sites.
 *
 * Reads the X-Company-Id header (not body/query — keeps every existing Joi
 * validation schema, several of them allowUnknown:false, untouched) and
 * checks it against the authenticated user's actual company membership.
 * req.companyId is always set from the DB-verified req.user.company_id,
 * never from the header directly — the header is only ever the thing being
 * validated against, never trusted as the source of truth. This closes a
 * header-spoofing path even while shadow mode is on.
 *
 * Shadow mode (COMPANY_SCOPE_SHADOW_MODE=true): mismatches are logged, never
 * blocked — lets the frontend's header rollout be observed with zero outage
 * risk before Phase 4 flips this to strict enforcement (a pure env-flag
 * flip, no code change).
 */
const resolveCompany = (req, res, next) => {
  if (req.user.is_platform_admin) {
    // Super/Platform Admin has no company and never touches business routes.
    return next();
  }

  const shadowMode = process.env.COMPANY_SCOPE_SHADOW_MODE !== 'false';

  const rawHeader = req.headers['x-company-id'];
  const headerCompanyId = rawHeader ? parseInt(rawHeader, 10) : null;
  const mismatch = !headerCompanyId || headerCompanyId !== req.user.company_id;

  if (mismatch) {
    logger.warn('Company header mismatch', {
      userId: req.userId,
      userCompanyId: req.user.company_id,
      headerCompanyId: rawHeader || null,
      path: req.path,
      method: req.method,
      shadowMode,
    });

    if (!shadowMode) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized: company mismatch.',
        code: 'COMPANY_MISMATCH',
      });
    }
  }

  req.companyId = req.user.company_id;
  next();
};

module.exports = resolveCompany;
