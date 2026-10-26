-- In-house AI layer, M8: drift checks (see docs/ai/ARCHITECTURE.md).
-- Additive only: one new ai_* table. Undo with:  node bin/hams-cli.js migrate:rollback ai_m8.sql
-- (roll back ai_m8.sql before ai_m7.sql).

-- One row per drift check of a model: how far today's data has moved from the data its active
-- version was trained on (PSI per feature, plus the KS test for numbers), and what was done.
CREATE TABLE IF NOT EXISTS ai_drift (
  id BIGSERIAL PRIMARY KEY,
  model_name VARCHAR(60) NOT NULL,
  model_version INT NOT NULL,
  checked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(20) NOT NULL,                 -- stable | moderate | significant
  max_psi NUMERIC(8,4) NOT NULL,
  features JSONB NOT NULL DEFAULT '[]',        -- [{ feature, kind, psi, ks_d, ks_p, status, shifts }]
  baseline_at TIMESTAMP,                       -- when the reference profile was taken
  baseline_rows INT,
  current_rows INT,
  action TEXT                                  -- e.g. "retraining started", "pinned: not retrained"
);
CREATE INDEX IF NOT EXISTS idx_ai_drift_model ON ai_drift (model_name, checked_at DESC);
