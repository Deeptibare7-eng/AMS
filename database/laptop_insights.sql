-- Laptop insights (see src/services/laptopInsightService.js):
--   assets.stock_site     stock site written in the register's Machine Name ("BL IT Stock ..." -> Bangalore)
--   assets.quality_grade  Good / Acceptable / Poor / Not deployable (laptops only)
--   assets.quality_reason why the grade was given
--   locations.site        campus/city a location belongs to (CT Mindspace-1 -> Mumbai - Mindspace)
-- Values are recomputed from the register fields after every import and asset save.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS stock_site VARCHAR(60);
ALTER TABLE assets ADD COLUMN IF NOT EXISTS quality_grade VARCHAR(20);
ALTER TABLE assets ADD COLUMN IF NOT EXISTS quality_reason VARCHAR(255);
ALTER TABLE locations ADD COLUMN IF NOT EXISTS site VARCHAR(60);

CREATE INDEX IF NOT EXISTS idx_assets_quality_grade ON assets(quality_grade) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_assets_stock_site ON assets(stock_site) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_locations_site ON locations(site);
