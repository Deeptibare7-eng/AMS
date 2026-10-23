-- In-house AI layer, M1 foundation (see docs/ai/ARCHITECTURE.md).
-- Additive only: new ai_* tables, the 'ai' module (switched OFF) and ai.* permissions.
-- No existing table or row is changed. Undo with:  node bin/hams-cli.js migrate:rollback ai.sql

-- Master switch: Settings > Feature Modules (or Settings > AI). Off until an admin turns it on.
INSERT INTO modules (name, label, icon, description, is_active) VALUES
('ai', 'AI Insights', 'sparkles', 'In-house AI: suggestions, data quality, risk scores and the AI Approvals inbox. AI only recommends; people approve every change.', FALSE)
ON CONFLICT (name) DO NOTHING;

INSERT INTO permissions (module_id, module, action, name) VALUES
((SELECT id FROM modules WHERE name = 'ai'), 'ai', 'view', 'ai.view'),
((SELECT id FROM modules WHERE name = 'ai'), 'ai', 'approve', 'ai.approve'),
((SELECT id FROM modules WHERE name = 'ai'), 'ai', 'manage', 'ai.manage')
ON CONFLICT (name) DO NOTHING;

-- Super and IT admins: everything. Asset managers and Location SPOCs: view + approve (within their
-- locations/sites). Fresh databases get the same grants from seed.sql (roles are seeded after migrate).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.module = 'ai'
 WHERE r.name IN ('super_admin', 'it_admin')
    OR (r.name IN ('asset_manager', 'location_spoc') AND p.action IN ('view', 'approve'))
ON CONFLICT DO NOTHING;

-- Per-asset AI features over time. One row per asset per snapshot date: a full copy on the first
-- run of each month, otherwise only assets whose features changed. No FK to assets on purpose:
-- history must survive the archive purge. Derived values are not stored: age comes from
-- purchase_date and snapshot_date, devices per holder from holder_user_id as of a date.
CREATE TABLE IF NOT EXISTS ai_feature_snapshots (
  id BIGSERIAL PRIMARY KEY,
  snapshot_date DATE NOT NULL,
  kind VARCHAR(10) NOT NULL DEFAULT 'change',          -- full | change
  asset_id INT NOT NULL,
  category_id INT,
  asset_model_id INT,
  manufacturer_id INT,
  supplier_id INT,
  location_id INT,
  stock_site VARCHAR(60),
  status VARCHAR(30),
  status_label_id INT,
  label_type VARCHAR(20),
  is_retired BOOLEAN NOT NULL DEFAULT FALSE,
  retired_reason VARCHAR(100),
  holder_user_id INT,
  purchase_date DATE,
  purchase_cost NUMERIC(14,2),
  warranty_expiry DATE,
  ram_gb INT,
  os_family VARCHAR(20),
  os_eol BOOLEAN,
  deleted BOOLEAN NOT NULL DEFAULT FALSE,
  feature_hash CHAR(32) NOT NULL,
  recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,   -- last write (same-day re-runs update the row)
  UNIQUE (asset_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_ai_snap_date ON ai_feature_snapshots (snapshot_date);
-- (asset_id, snapshot_date) latest-row lookups use the UNIQUE index above.

-- Lifecycle events the register itself does not keep (e.g. when an asset was retired).
-- precision 'exact': seen live in the app; 'snapshot': happened between window_start and occurred_at
-- (bulk imports change assets without per-asset events).
CREATE TABLE IF NOT EXISTS ai_asset_events (
  id BIGSERIAL PRIMARY KEY,
  asset_id INT NOT NULL,
  event_type VARCHAR(30) NOT NULL,                     -- retired | unretired | assigned | unassigned | status_changed | site_changed | location_changed | deleted
  occurred_at TIMESTAMP NOT NULL,
  window_start DATE,
  precision VARCHAR(10) NOT NULL,                      -- exact | snapshot
  from_value VARCHAR(120),
  to_value VARCHAR(120),
  source VARCHAR(20) NOT NULL,                         -- event | snapshot
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ai_events_asset ON ai_asset_events (asset_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_ai_events_type ON ai_asset_events (event_type, occurred_at);

-- Model registry: every trained version with its parameters and metrics; one active per name.
CREATE TABLE IF NOT EXISTS ai_models (
  id SERIAL PRIMARY KEY,
  name VARCHAR(60) NOT NULL,
  version INT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'candidate',     -- candidate | active | retired
  params JSONB NOT NULL,
  metrics JSONB,
  training JSONB,                                      -- data window, row counts, features
  trained_by INT REFERENCES users(id) ON DELETE SET NULL,
  trained_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  activated_at TIMESTAMP,
  UNIQUE (name, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_models_active ON ai_models (name) WHERE status = 'active';

-- AI Approvals inbox: what an agent recommends, why, and what a person decided.
CREATE TABLE IF NOT EXISTS ai_recommendations (
  id BIGSERIAL PRIMARY KEY,
  type VARCHAR(60) NOT NULL,                           -- handler key, e.g. 'dq.fix_category'
  agent VARCHAR(40) NOT NULL,
  target_type VARCHAR(30) NOT NULL,                    -- asset | asset_model | supplier | site | ...
  target_id INT,
  location_id INT,                                     -- approver scoping (role location scopes)
  site VARCHAR(60),                                    -- approver scoping (Location SPOC sites)
  title VARCHAR(255) NOT NULL,
  why JSONB NOT NULL DEFAULT '[]',                     -- top factors in plain language
  proposed JSONB NOT NULL DEFAULT '{}',                -- the change accepting would make
  confidence NUMERIC(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  model_name VARCHAR(60),
  model_version INT,
  dedupe_key VARCHAR(200),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',       -- pending | applying | accepted | rejected | failed | expired
  decided_by INT REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMP,
  decision_note TEXT,
  applied_result JSONB,
  run_id BIGINT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_rec_open ON ai_recommendations (dedupe_key) WHERE status IN ('pending', 'applying');
CREATE INDEX IF NOT EXISTS idx_ai_rec_status ON ai_recommendations (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_rec_target ON ai_recommendations (target_type, target_id);

-- Training labels from people's decisions (the feedback loop).
CREATE TABLE IF NOT EXISTS ai_feedback (
  id BIGSERIAL PRIMARY KEY,
  recommendation_id BIGINT REFERENCES ai_recommendations(id) ON DELETE SET NULL,
  capability VARCHAR(40) NOT NULL,
  model_name VARCHAR(60),
  model_version INT,
  target_type VARCHAR(30),
  target_id INT,
  label VARCHAR(20) NOT NULL,                          -- accepted | rejected | edited | ignored
  predicted JSONB,
  actual JSONB,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ai_feedback_cap ON ai_feedback (capability, created_at);
