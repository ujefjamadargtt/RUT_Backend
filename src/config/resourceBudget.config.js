'use strict';

/**
 * Resource Budget Master — the maximum total planned hours one employee may
 * be budgeted across ALL Service POs in a single month. Centralized here,
 * same pattern as servicePOMonthlyBudget.config.js's DEADLINE_DAY, so the
 * cap can be changed without touching service/controller code. Override via
 * RESOURCE_BUDGET_MAX_MONTHLY_HOURS for environments that need a different cap.
 */
const MAX_MONTHLY_HOURS = parseInt(process.env.RESOURCE_BUDGET_MAX_MONTHLY_HOURS, 10) || 176;

module.exports = {
  MAX_MONTHLY_HOURS,
};
