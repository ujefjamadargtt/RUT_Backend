'use strict';

const rbacService = require('../services/rbacService');
const logger = require('../utils/logger');

/**
 * Gate an endpoint behind a single RBAC form (Form Master / Role Form Mapping),
 * e.g. requireFormAccess('AI Copilot') on the AI Copilot chat route. Must run after authenticate.
 *
 * Decided from exactly the same data the login / refresh-token response gives the frontend
 * (rbacService.getActiveFormsForRoles): the form must be active, actively mapped to the caller's
 * ACTIVE role, and its module must be active — so "the widget is hidden" and "the API says 403"
 * can never disagree. Form names are matched exactly (case-sensitive).
 *
 * Platform Admin (hierarchy_rank 1) bypasses role_form_mapping entirely, as it does for every
 * other form ("All Forms" is every active form, not literal mapping rows).
 *
 * @param {string} formName - exact form_name, e.g. 'AI Copilot'
 * @returns {import('express').RequestHandler}
 */
const requireFormAccess = (formName) => async (req, res, next) => {
  try {
    if (req.hierarchyRank === 1) return next();

    const roleIds = (req.activeRoles || []).map((role) => role.id);
    const formsByModule = roleIds.length > 0
      ? await rbacService.getActiveFormsForRoles(roleIds, req.hierarchyRank)
      : {};
    const hasForm = Object.values(formsByModule).some((forms) => forms.some((form) => form.name === formName));

    if (!hasForm) {
      logger.warn('Form access denied', { userId: req.userId, formName, path: req.path, method: req.method });
      return res.status(403).json({
        success: false,
        message: `Access denied. Your role does not have access to "${formName}".`,
        code: 'FORM_ACCESS_DENIED',
      });
    }
    return next();
  } catch (err) {
    return next(err);
  }
};

module.exports = requireFormAccess;
