BEGIN;

-- Whether users assigned to this role may view original/raw data in the
-- application (as opposed to whatever admin-adjusted/derived view applies
-- otherwise). Defaults to false — original data is hidden unless a role is
-- explicitly granted visibility.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_original_data_visible BOOLEAN NOT NULL DEFAULT false;

COMMIT;
