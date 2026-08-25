-- =============================================================================
-- Business Unit is now optional when creating a Client (matching Employee's
-- existing "BU mapped later" treatment) — a company-less Admin/Entity Admin
-- may create a Client with no Business Unit at all, mapped afterward via
-- update(). See clientService.js's resolveOptionalCreateCompanyId() usage.
-- projects.company_id is already nullable; this brings clients in line.
-- =============================================================================

BEGIN;

ALTER TABLE clients
  ALTER COLUMN company_id DROP NOT NULL;

COMMIT;
