-- Performance indexes for the hardware asset module (idempotent; safe to re-run).
-- Search boxes and type-to-search pickers use ILIKE '%term%', which plain b-tree
-- indexes cannot serve, so text search columns get pg_trgm GIN indexes.
-- pg_trgm is a trusted extension: the database owner can create it (no superuser).
-- For a large live database, run each CREATE INDEX with CONCURRENTLY instead.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---- assets (hardware) ----
CREATE INDEX IF NOT EXISTS idx_assets_name_trgm       ON assets USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_assets_tag_trgm        ON assets USING gin (asset_tag gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_assets_serial_trgm     ON assets USING gin (serial_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_assets_model_no_trgm   ON assets USING gin (model_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_assets_live_created    ON assets (created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_assets_assigned_to     ON assets (assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_assets_category_id     ON assets (category_id);
CREATE INDEX IF NOT EXISTS idx_assets_model_id        ON assets (asset_model_id);
CREATE INDEX IF NOT EXISTS idx_assets_status          ON assets (status);
CREATE INDEX IF NOT EXISTS idx_assets_procurement_id  ON assets (procurement_id);
CREATE INDEX IF NOT EXISTS idx_assets_warranty_expiry ON assets (warranty_expiry) WHERE deleted_at IS NULL;

-- ---- users (employee name / email / CTID) ----
CREATE INDEX IF NOT EXISTS idx_users_name_trgm        ON users USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_users_email_trgm       ON users USING gin (email gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_users_employee_id_trgm ON users USING gin (employee_id gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_users_email_lower      ON users (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_users_location_id      ON users (location_id);
CREATE INDEX IF NOT EXISTS idx_users_live_created     ON users (created_at DESC, id DESC) WHERE deleted_at IS NULL;

-- ---- assignments ----
CREATE INDEX IF NOT EXISTS idx_assignments_asset_open ON assignments (asset_id) WHERE returned_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_assignments_asset_id   ON assignments (asset_id);
CREATE INDEX IF NOT EXISTS idx_assignments_user_id    ON assignments (user_id);
CREATE INDEX IF NOT EXISTS idx_acc_assign_user_id     ON accessory_assignments (user_id);

-- ---- accessories ----
CREATE INDEX IF NOT EXISTS idx_accessories_name_trgm  ON accessories USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_accessories_live_name  ON accessories (name, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_accessories_location   ON accessories (location_id);
CREATE INDEX IF NOT EXISTS idx_accessories_category   ON accessories (category_id);

-- ---- catalog / procurement / maintenance / ledger ----
CREATE INDEX IF NOT EXISTS idx_asset_models_mfr       ON asset_models (manufacturer_id);
CREATE INDEX IF NOT EXISTS idx_asset_models_name_trgm ON asset_models USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_procurement_vendor     ON procurement_records (vendor_id);
CREATE INDEX IF NOT EXISTS idx_procurement_live_date  ON procurement_records (purchase_date DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_procurement_po_trgm    ON procurement_records USING gin (po_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_maintenance_asset_id   ON asset_maintenance (asset_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_created    ON asset_maintenance (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_stock_mv_created       ON stock_movements (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_stock_mv_created_by    ON stock_movements (created_by);

ANALYZE assets;
ANALYZE users;
ANALYZE assignments;
ANALYZE accessory_assignments;
ANALYZE accessories;
ANALYZE stock_movements;
