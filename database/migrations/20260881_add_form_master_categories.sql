-- =============================================================================
-- Form Master — optional Category layer between Module and Form.
--
-- Adds a new `categories` table (module_id -> form_master.id, i.e. a
-- module ROW's own id — see database/migrations/
-- 20260856_add_form_master_seq_and_modules.sql for how a module is
-- represented as a form_master row with module_name IS NULL) and a
-- nullable `form_master.category_id` pointing at it.
--
-- A form with category_id = NULL is still directly under its module
-- (Module -> Form, unchanged); category_id set means Module -> Category
-- -> Form. Every existing form_master row is untouched — category_id
-- defaults to NULL, so nothing already registered is reassigned.
--
-- The cross-table invariant "a form's category must belong to the same
-- module as the form" is NOT expressible as a plain CHECK (it needs a
-- join) and is enforced in formMasterService.js instead, consistent with
-- how this codebase already validates module_name in createForm()/
-- updateForm() at the service layer rather than via DB triggers (the only
-- DB function in this schema is the generic trigger_set_updated_at()).
--
-- Safe to re-run: every statement is IF NOT EXISTS / CREATE OR REPLACE /
-- guarded DROP+ADD CONSTRAINT.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS categories (
  id          SERIAL PRIMARY KEY,
  module_id   INT NOT NULL REFERENCES form_master (id) ON DELETE RESTRICT,
  name        VARCHAR(100) NOT NULL,
  description VARCHAR(255),
  status      VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  seq         INT NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_categories_module_name UNIQUE (module_id, name)
);

ALTER TABLE categories DROP CONSTRAINT IF EXISTS chk_categories_seq_positive;
ALTER TABLE categories ADD CONSTRAINT chk_categories_seq_positive CHECK (seq > 0);

CREATE INDEX IF NOT EXISTS idx_categories_module_id ON categories (module_id);
CREATE INDEX IF NOT EXISTS idx_categories_status ON categories (status);

DROP TRIGGER IF EXISTS trg_categories_updated_at ON categories;
CREATE TRIGGER trg_categories_updated_at BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

ALTER TABLE form_master ADD COLUMN IF NOT EXISTS category_id INT REFERENCES categories (id) ON DELETE RESTRICT;

-- A category can only ever be attached to a FORM row (module_name IS NOT
-- NULL) — module rows (module_name IS NULL) must never carry a category_id.
ALTER TABLE form_master DROP CONSTRAINT IF EXISTS chk_form_master_category_requires_form_row;
ALTER TABLE form_master ADD CONSTRAINT chk_form_master_category_requires_form_row
  CHECK (category_id IS NULL OR module_name IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_form_master_category_id ON form_master (category_id);

COMMIT;
