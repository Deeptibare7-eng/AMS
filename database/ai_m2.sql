-- In-house AI layer, M2: data health and intake (see docs/ai/ARCHITECTURE.md).
-- Additive only: three new ai_* tables. Undo with:  node bin/hams-cli.js migrate:rollback ai_m2.sql
-- (roll back ai_m2.sql before ai.sql).

-- One row per data-health scan: fleet score, issue counts, scores by location and by module.
CREATE TABLE IF NOT EXISTS ai_dq_runs (
  id SERIAL PRIMARY KEY,
  run_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  trigger VARCHAR(20) NOT NULL,
  assets INT NOT NULL,                          -- active assets scored
  avg_score NUMERIC(5,1),
  issues JSONB NOT NULL DEFAULT '{}',           -- issue code -> affected assets
  by_location JSONB NOT NULL DEFAULT '[]',
  modules JSONB NOT NULL DEFAULT '[]',          -- [{ module, score, checks: [{ label, ok, total }] }]
  catalog JSONB NOT NULL DEFAULT '{}',          -- catalog findings (model spelling variants, supplier groups, ...)
  duration_ms INT
);
CREATE INDEX IF NOT EXISTS idx_ai_dq_runs_at ON ai_dq_runs (run_at DESC);

-- The latest scan's issues, one row per asset and issue (replaced on every scan).
CREATE TABLE IF NOT EXISTS ai_dq_issues (
  asset_id INT NOT NULL,
  code VARCHAR(40) NOT NULL,
  severity VARCHAR(10) NOT NULL,                -- high | medium | low
  confidence NUMERIC(4,3) NOT NULL DEFAULT 1,
  detail TEXT NOT NULL,                         -- plain-language reason shown to people
  data JSONB,
  run_id INT REFERENCES ai_dq_runs(id) ON DELETE SET NULL,
  PRIMARY KEY (asset_id, code)
);
CREATE INDEX IF NOT EXISTS idx_ai_dq_issues_code ON ai_dq_issues (code);

-- Latest per-asset AI output by capability (e.g. data_quality: the 0-100 data health score).
CREATE TABLE IF NOT EXISTS ai_predictions (
  asset_id INT NOT NULL,
  capability VARCHAR(40) NOT NULL,
  score NUMERIC(8,3),
  confidence NUMERIC(4,3),
  label VARCHAR(60),
  factors JSONB,                                -- top factors, plain language
  model_name VARCHAR(60),
  model_version INT,
  computed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (asset_id, capability)
);
CREATE INDEX IF NOT EXISTS idx_ai_predictions_cap ON ai_predictions (capability, score);
