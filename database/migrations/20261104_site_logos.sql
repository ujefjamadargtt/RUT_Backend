-- =============================================================================
-- Dynamic site logo — a Platform Admin uploads logo images (JPG / PNG / GIF)
-- and picks which one the whole site shows.
--
-- The image bytes live in Postgres (bytea) rather than on disk, because the
-- app also runs on hosts with an ephemeral filesystem. Logos are small
-- (the API limits uploads to 2 MB).
--
-- At most ONE row may be active at a time; the partial unique index enforces
-- this in the database. When no row is active the frontend falls back to its
-- built-in logo.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS site_logos (
  id          SERIAL       PRIMARY KEY,
  file_name   VARCHAR(255) NOT NULL,
  mime_type   VARCHAR(50)  NOT NULL,
  file_size   INTEGER      NOT NULL,
  image_data  BYTEA        NOT NULL,
  is_active   BOOLEAN      NOT NULL DEFAULT FALSE,
  uploaded_by INTEGER      REFERENCES employees(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Enforce "at most one active logo" at the database level.
CREATE UNIQUE INDEX IF NOT EXISTS uq_site_logos_single_active
  ON site_logos (is_active)
  WHERE is_active;

COMMIT;
