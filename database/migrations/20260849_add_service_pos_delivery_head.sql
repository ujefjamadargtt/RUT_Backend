-- =============================================================================
-- Client -> Project -> Service PO -> Delivery Head — Phase 2: Service PO
-- gets a Delivery Head.
--
-- delivery_head_employee_id references employees(id) — the Employee
-- Master ID, NOT a User Master ID (Delivery Head is a business/staffing
-- attribute of the Service PO, unrelated to login/RBAC identity).
--
-- Nullable at the DB level: existing Service POs created before this
-- feature have no Delivery Head and must not break (see
-- src/services/servicePOService.js — Delivery Head is required by Joi
-- only on CREATE, optional on UPDATE, so a pre-existing PO can have one
-- added later without being forced through unrelated-field validation).
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE service_pos
  ADD COLUMN IF NOT EXISTS delivery_head_employee_id INT REFERENCES employees (id);

CREATE INDEX IF NOT EXISTS idx_service_pos_delivery_head_employee_id ON service_pos (delivery_head_employee_id);

COMMIT;
