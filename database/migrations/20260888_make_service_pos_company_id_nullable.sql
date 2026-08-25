-- =============================================================================
-- Business Unit is now optional when creating a Service PO (matching
-- Employee/Client/Project's existing "BU mapped later" treatment) — a
-- company-less Admin/Entity Admin may create a Service PO with no Business
-- Unit at all, assigned afterward via update(). See servicePOService.js's
-- resolveOptionalCreateCompanyId() usage. clients.company_id and
-- projects.company_id are already nullable (see
-- 20260887_make_clients_company_id_nullable.sql); this brings service_pos
-- in line. The ServicePO model (src/models/ServicePO.js) already declares
-- `company_id: { allowNull: true }` — this migration is what makes the
-- live database actually match that.
-- =============================================================================

BEGIN;

ALTER TABLE service_pos
  ALTER COLUMN company_id DROP NOT NULL;

COMMIT;
