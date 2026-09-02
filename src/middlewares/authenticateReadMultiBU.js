'use strict';

const authenticate = require('./auth');
const resolveReportCompanyScope = require('./resolveReportCompanyScope');

/**
 * Shared GET-only middleware pair for every list/detail endpoint converted
 * to the "no X-Company-Id -> role reach across every BU the caller is
 * mapped to" contract (see resolveReportCompanyScope.js's doc comment).
 * Deliberately authenticateIdentity, not the full authenticate default
 * export — resolveCompany.js (its tail) 400s a BU-scoped caller mapped to
 * more than one Business Unit who omits the header, before
 * resolveReportCompanyScope would ever get a chance to run.
 *
 * Sets req.companyIds (array, always defined) — never req.companyId.
 * Mount only on GET routes; writes must keep the full `authenticate` chain
 * (a create/update/delete always needs exactly one target BU, never an
 * aggregated set).
 */
module.exports = [authenticate.authenticateIdentity, resolveReportCompanyScope];
