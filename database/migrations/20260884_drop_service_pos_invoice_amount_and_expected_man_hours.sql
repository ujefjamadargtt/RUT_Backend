-- =============================================================================
-- Drop service_pos.invoice_amount and service_pos.expected_man_hours.
--
-- Retired per explicit product decision — these two fields are no longer
-- captured on a Service PO. Downstream features that read them were
-- updated in the same change:
--   - GET /service-pos/:id/utilisation now returns only total_hours_logged
--     (no more expected_man_hours/remaining_hours/utilisation_percentage/
--     is_over_utilised — those all required an expected-hours target).
--   - Dashboard's overall_utilisation_pct (/dashboard/stats) and
--     capacity_utilisation_pct (/dashboard/analytics) are removed entirely.
--   - Management Report's "Service PO Budget & Timeline Exhaustion Risk"
--     report now reports date-elapsed risk only (on_track/overdue) — the
--     hours-budget dimension (consumed_hours_pct, at_risk/critical levels,
--     projected_exhaustion_date) is gone.
--   - Management Report's Delivery Head Performance report no longer has
--     an at_risk_po_count column.
--   - Report Service PO Summary report loses invoiced_amount/unbilled_amount/
--     available_hours/expected_man_hours entirely. Invoice PO Summary report
--     loses available_hours/expected_man_hours only — its invoiced_amount/
--     billed_amount/unbilled_amount already came from
--     service_po_monthly_budgets, not this table, and are unaffected.
--   - AI Insight "new PO staffing suggestion" context and the AI Copilot
--     Service PO summary picker no longer include expected_man_hours.
--   - The Service PO import (Excel/CSV) no longer recognizes either column.
--
-- cost_budget_master.invoice_amount and service_po_monthly_budgets.
-- invoice_amount are UNRELATED tables that happen to share the field name —
-- neither is touched by this migration.
--
-- Irreversible data-wise: the rollback re-adds both columns (nullable), but
-- any values they held are gone — same as every other DROP COLUMN migration
-- in this repo (e.g. 20260880_truncate_users.sql).
-- =============================================================================

BEGIN;

ALTER TABLE service_pos DROP COLUMN IF EXISTS invoice_amount;
ALTER TABLE service_pos DROP COLUMN IF EXISTS expected_man_hours;

COMMIT;
