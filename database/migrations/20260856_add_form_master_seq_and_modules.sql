-- =============================================================================
-- Form Master — module-as-row + sequence support.
--
-- form_master stays the ONLY table for both modules and forms (no new
-- module_master/modules table). A module is now representable as a
-- form_master row in its own right:
--   module_name = NULL, form_name = <module name>
-- Every existing distinct module_name value gets exactly one such row
-- created here, backfilled with a module-level seq. Every existing child
-- form gets a seq assigned independently within its own module (not a
-- global sequence). Existing form_master ids, and every role_form_mapping
-- row referencing them, are left completely untouched.
--
-- Safe to re-run: the module backfill only inserts a module row that
-- doesn't already exist, and the seq backfill only assigns rows that don't
-- already have one, so a second run is a no-op.
-- =============================================================================

BEGIN;

ALTER TABLE form_master ALTER COLUMN module_name DROP NOT NULL;
ALTER TABLE form_master ADD COLUMN IF NOT EXISTS seq INTEGER;

-- One module row per existing distinct module_name value, sequenced
-- alphabetically (there is no better existing signal to order modules by).
INSERT INTO form_master (module_name, form_name, status, seq, created_at, updated_at)
SELECT NULL, distinct_modules.module_name, 'active', distinct_modules.rn, NOW(), NOW()
FROM (
  SELECT module_name, ROW_NUMBER() OVER (ORDER BY module_name ASC) AS rn
  FROM (SELECT DISTINCT module_name FROM form_master WHERE module_name IS NOT NULL) AS m
) AS distinct_modules
WHERE NOT EXISTS (
  SELECT 1 FROM form_master existing
  WHERE existing.module_name IS NULL AND existing.form_name = distinct_modules.module_name
);

-- Sequence every existing child form independently within its own module,
-- preserving the (module_name, form_name) ordering the app already sorted
-- by before this column existed.
UPDATE form_master fm
SET seq = ranked.rn
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY module_name ORDER BY form_name ASC, id ASC) AS rn
  FROM form_master
  WHERE module_name IS NOT NULL
) AS ranked
WHERE fm.id = ranked.id AND fm.seq IS NULL;

ALTER TABLE form_master ALTER COLUMN seq SET NOT NULL;

ALTER TABLE form_master DROP CONSTRAINT IF EXISTS chk_form_master_seq_positive;
ALTER TABLE form_master ADD CONSTRAINT chk_form_master_seq_positive CHECK (seq > 0);

-- Module names must be unique among module rows. The existing
-- uq_form_master_module_form constraint (module_name, form_name) already
-- keeps a module's own children unique, but a plain multi-column UNIQUE
-- constraint does not de-duplicate across rows where module_name IS NULL
-- (Postgres treats every NULL as distinct), so module-name uniqueness needs
-- its own partial index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_form_master_module_row_name
  ON form_master (form_name)
  WHERE module_name IS NULL;

CREATE INDEX IF NOT EXISTS idx_form_master_seq ON form_master (seq);

COMMIT;
