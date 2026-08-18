-- =============================================================================
-- Refresh token rotation + replay prevention (security fix).
--
-- user_sessions previously tracked only the raw refresh_token string, with
-- no per-token identifier and no way to distinguish "never existed" from
-- "already consumed" once a session row was hard-deleted on rotation/logout
-- — which also meant an already-rotated token being replayed couldn't be
-- detected (its row was simply gone). This adds:
--   jti              - unique per-issuance identifier, embedded in the
--                      refresh JWT's own `jti` claim (see src/config/jwt.js)
--                      and used as the sole lookup/rotation key going
--                      forward, instead of matching the raw token string.
--   family_id        - shared across every token descended from one login,
--                      so a detected replay can revoke the whole lineage.
--   revoked_at       - rotation/logout now SOFT-revoke (set this) instead
--                      of deleting the row, so a replayed already-consumed
--                      token is recognizable as "reuse", not "unknown".
--   replaced_by_jti  - which token a rotated session was replaced by, for
--                      tracing a family's lineage.
--
-- Existing, already-issued refresh tokens have no `jti` claim (signed
-- before this fix) and cannot be looked up by the new mechanism — they are
-- intentionally treated as invalid after this deploys; affected users
-- simply log in again once their current access token expires. This is an
-- expected, one-time consequence of closing the underlying rotation bug,
-- not a bug in this migration.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE user_sessions
  ADD COLUMN IF NOT EXISTS jti VARCHAR(36),
  ADD COLUMN IF NOT EXISTS family_id VARCHAR(36),
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS replaced_by_jti VARCHAR(36);

-- Partial unique index: NULL jti (every pre-existing row) is never compared
-- for uniqueness, so backfilling nothing here is safe.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_sessions_jti
  ON user_sessions (jti) WHERE jti IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_user_sessions_family_id
  ON user_sessions (family_id);

-- The refresh flow's hot-path lookup: "is there a live, unrevoked session
-- for this jti", i.e. exactly the WHERE clause consumeSession()/
-- findActiveSessionByJti() use in authRepository.js.
CREATE INDEX IF NOT EXISTS idx_user_sessions_jti_revoked_at
  ON user_sessions (jti, revoked_at);

COMMIT;
