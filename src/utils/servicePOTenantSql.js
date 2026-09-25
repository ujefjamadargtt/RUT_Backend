'use strict';

/**
 * Raw-SQL tenant boundary for a BU-less (company_id NULL) Service PO — in
 * practice an Admin-created Centralised PO (Leaves, On Bench, ...).
 *
 * Dashboard/report queries used to scope Service POs as
 * `(sp.company_id IN (:companyIds) OR sp.company_id IS NULL)` — the bare
 * `IS NULL` pulled EVERY Admin's BU-less POs into every other Admin's
 * dashboards and reports. A BU-less PO is not global: it belongs to the
 * Admin tenant of whoever created it. This fragment keeps the NULL branch
 * but bounds it to POs whose `created_by` is an Admin/Entity Admin of the
 * viewer's own Companies — the SQL mirror of companyAccessControlService.
 * resolveCentralisedOwnerCreatorIds() (entities.created_by +
 * entities.entity_admin_employee_id), derived from the SAME `:companyIds`
 * replacement the query already binds, so no caller has to pass anything new.
 *
 * @param {string|null} alias - the service_pos table alias (e.g. 'sp'), or null/'' for an unaliased table
 * @param {string} [param='companyIds'] - the replacement name holding the viewer's Company id(s)
 * @returns {string}
 */
function buLessServicePOInTenantSql(alias, param = 'companyIds') {
  const col = alias ? `${alias}.` : '';
  return `(${col}company_id IS NULL AND ${col}created_by IN (
      SELECT tenant_e.created_by FROM companies tenant_c
        JOIN entities tenant_e ON tenant_e.id = tenant_c.entity_id AND tenant_e.is_deleted = false
       WHERE tenant_c.id IN (:${param}) AND tenant_c.is_deleted = false AND tenant_e.created_by IS NOT NULL
      UNION
      SELECT tenant_e.entity_admin_employee_id FROM companies tenant_c
        JOIN entities tenant_e ON tenant_e.id = tenant_c.entity_id AND tenant_e.is_deleted = false
       WHERE tenant_c.id IN (:${param}) AND tenant_c.is_deleted = false AND tenant_e.entity_admin_employee_id IS NOT NULL
    ))`;
}

module.exports = { buLessServicePOInTenantSql };
