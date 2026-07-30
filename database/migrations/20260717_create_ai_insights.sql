-- Migration: create AI Insights module tables
-- ai_insight_jobs   : job configuration (one row per insight type)
-- ai_insights       : generated AI insights (one row per Claude generation)
--
-- To apply:
-- psql -U <db_user> -d <database> -f database/migrations/20260717_create_ai_insights.sql
--
-- NOTE: in development, these tables are also created automatically by
-- sequelize.sync({ alter: false }) on server startup (see server.js), since
-- they are brand-new tables with no pre-existing data to alter. This
-- migration exists for production environments where sync() is not run.

BEGIN;

CREATE TABLE IF NOT EXISTS ai_insight_jobs (
  id               SERIAL PRIMARY KEY,
  job_key          VARCHAR(100) NOT NULL,
  title            VARCHAR(200) NOT NULL,
  description      TEXT,
  frequency        VARCHAR(20)  NOT NULL
                                CHECK (frequency IN ('daily', 'weekly', 'monthly', 'quarterly', 'event')),
  cron_expression  VARCHAR(50),
  audience_roles   JSONB        NOT NULL DEFAULT '[]',
  is_active        BOOLEAN      NOT NULL DEFAULT true,
  last_run_at      TIMESTAMP,
  last_run_status  VARCHAR(20)  CHECK (last_run_status IN ('success', 'failed')),
  last_error       TEXT,
  created_at       TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMP    NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_ai_insight_jobs_job_key UNIQUE (job_key)
);

DROP TRIGGER IF EXISTS trg_ai_insight_jobs_updated_at ON ai_insight_jobs;
CREATE TRIGGER trg_ai_insight_jobs_updated_at
  BEFORE UPDATE ON ai_insight_jobs
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TABLE IF NOT EXISTS ai_insights (
  id             SERIAL PRIMARY KEY,
  job_id         INT REFERENCES ai_insight_jobs(id),
  job_key        VARCHAR(100) NOT NULL,
  reference_id   INT,
  title          VARCHAR(300) NOT NULL,
  severity       VARCHAR(20)  NOT NULL DEFAULT 'info'
                              CHECK (severity IN ('critical', 'warning', 'info')),
  summary        TEXT,
  findings       JSONB        NOT NULL DEFAULT '[]',
  actions        JSONB        NOT NULL DEFAULT '[]',
  audience_roles JSONB        NOT NULL DEFAULT '[]',
  ai_response    JSONB,
  generated_at   TIMESTAMP    NOT NULL DEFAULT NOW(),
  status         VARCHAR(20)  NOT NULL DEFAULT 'completed'
                              CHECK (status IN ('completed', 'failed')),
  is_read        BOOLEAN      NOT NULL DEFAULT false,
  is_dismissed   BOOLEAN      NOT NULL DEFAULT false,
  created_at     TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_insights_job_key      ON ai_insights (job_key);
CREATE INDEX IF NOT EXISTS idx_ai_insights_is_read       ON ai_insights (is_read);
CREATE INDEX IF NOT EXISTS idx_ai_insights_is_dismissed  ON ai_insights (is_dismissed);
CREATE INDEX IF NOT EXISTS idx_ai_insights_generated_at  ON ai_insights (generated_at);

DROP TRIGGER IF EXISTS trg_ai_insights_updated_at ON ai_insights;
CREATE TRIGGER trg_ai_insights_updated_at
  BEFORE UPDATE ON ai_insights
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

COMMIT;
