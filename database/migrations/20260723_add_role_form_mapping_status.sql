BEGIN;

-- Soft-mapping flag for role_form_mapping: true = form currently mapped
-- (active) to the role, false = unmapped (inactive) — rows are never
-- physically deleted, only toggled. Existing rows predate this column and
-- represent mappings that were, by their mere existence, active — so they
-- default (and backfill) to true.
ALTER TABLE role_form_mapping ADD COLUMN IF NOT EXISTS status BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_role_form_mapping_status ON role_form_mapping (status);

COMMIT;
