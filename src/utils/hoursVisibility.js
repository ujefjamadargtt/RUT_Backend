'use strict';

/**
 * Shapes an array of timesheet rows' hours fields based on the caller's
 * resolved role. Used by the plain timesheet read endpoints (GET
 * /timesheets, GET /timesheets/:id, GET /timesheets/import/:id/rows) —
 * NOT by reports/dashboards, which use a different switch (hoursSource,
 * see src/repositories/*.js) that intentionally overrides this rule.
 *
 * IMPORTANT: `role` here must come from the request body/query
 * (req.body.role / req.query.role), NOT req.userRoles/the JWT — this is an
 * explicit product decision made for this feature; do not "fix" it to read
 * the authenticated user's real role.
 *
 * Rule:
 *  - role (case-insensitive) === "management": each row exposes ONLY the
 *    effective hours, under the existing `hours_logged` field name —
 *    modified_hours ONLY if this row's is_publish is true (falling back to
 *    the original hours_logged if modified_hours is still null); if
 *    is_publish is false, the original hours_logged is shown even when a
 *    modified_hours edit is already saved, since it hasn't been published
 *    yet. modified_hours is not included in the output at all in this case.
 *  - any other role, or no role given: both fields are returned as stored —
 *    hours_logged stays the true original value, modified_hours is included
 *    alongside it unchanged (which may itself be null if never set).
 *
 * Pure function — does not mutate the input rows.
 *
 * @param {object[]} rows - plain objects or Sequelize instances (uses .toJSON() if present)
 * @param {string} [role]
 * @returns {object[]}
 */
function applyHoursVisibility(rows, role) {
  const isManagement = typeof role === 'string' && role.trim().toLowerCase() === 'management';

  return rows.map((row) => {
    const plain = typeof row.toJSON === 'function' ? row.toJSON() : { ...row };

    if (!isManagement) {
      return plain;
    }

    const { modified_hours, ...rest } = plain;
    return {
      ...rest,
      hours_logged: plain.is_publish ? (modified_hours ?? plain.hours_logged) : plain.hours_logged,
    };
  });
}

module.exports = { applyHoursVisibility };
