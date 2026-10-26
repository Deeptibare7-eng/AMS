-- In-house AI layer, M7: agents and the orchestrator (see docs/ai/ARCHITECTURE.md).
-- Additive only: two new ai_* tables and one column on ai_recommendations (an AI table).
-- Undo with:  node bin/hams-cli.js migrate:rollback ai_m7.sql   (roll back ai_m7.sql before ai_m2.sql).

-- One row per orchestrator run: which flow, what started it, its task graph, the shared context
-- (blackboard) at the end, and how it went.
CREATE TABLE IF NOT EXISTS ai_runs (
  id BIGSERIAL PRIMARY KEY,
  flow VARCHAR(40) NOT NULL,                   -- asset.review | import.review | maintenance.review | licence.review | fleet.review | ask
  trigger VARCHAR(40) NOT NULL,                -- the event name, 'schedule', 'manual' or 'request'
  target_type VARCHAR(30),
  target_id INT,
  location_id INT,                             -- for scoping who may see the trace
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'running', -- running | done | partial | failed
  summary TEXT,
  dag JSONB NOT NULL DEFAULT '[]',             -- nodes, their agents and dependencies (and the ones left out)
  context JSONB NOT NULL DEFAULT '{}',         -- blackboard: claims, findings, decisions (trimmed)
  error TEXT,
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP,
  duration_ms INT
);
CREATE INDEX IF NOT EXISTS idx_ai_runs_started ON ai_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_runs_target ON ai_runs (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_ai_runs_flow ON ai_runs (flow, started_at DESC);

-- One row per step of a run: the agent, the tools it called, what it produced, retries and timing.
CREATE TABLE IF NOT EXISTS ai_run_steps (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES ai_runs(id) ON DELETE CASCADE,
  node VARCHAR(40) NOT NULL,
  agent VARCHAR(40) NOT NULL,
  depends_on JSONB NOT NULL DEFAULT '[]',
  status VARCHAR(20) NOT NULL,                 -- done | failed | timeout | skipped
  attempts INT NOT NULL DEFAULT 0,
  tool_calls JSONB NOT NULL DEFAULT '[]',
  output JSONB,
  error TEXT,
  started_at TIMESTAMP,
  finished_at TIMESTAMP,
  duration_ms INT
);
CREATE INDEX IF NOT EXISTS idx_ai_run_steps_run ON ai_run_steps (run_id, id);

-- Agents that disagree (or are unsure) still go to AI Approvals, marked for a closer look.
ALTER TABLE ai_recommendations ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_ai_rec_run ON ai_recommendations (run_id) WHERE run_id IS NOT NULL;
