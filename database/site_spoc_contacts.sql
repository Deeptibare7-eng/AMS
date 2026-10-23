-- A SPOC can be listed as a contact (name + phone) before they have an account: user_id stays
-- empty until an admin enables sign-in with their email. `name` is the name shown for the SPOC.
-- Idempotent.
ALTER TABLE site_spocs ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE site_spocs ADD COLUMN IF NOT EXISTS name VARCHAR(255);
UPDATE site_spocs s SET name = u.name FROM users u WHERE u.id = s.user_id AND s.name IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_site_spocs_contact ON site_spocs (site, LOWER(name)) WHERE user_id IS NULL;

-- Each site's office as people know it ("Mumbai - Airoli") and its postal address, shown on the
-- Location SPOCs page, in the Location Workspace and in new-joiner emails.
CREATE TABLE IF NOT EXISTS site_offices (
  site VARCHAR(60) PRIMARY KEY,
  office_name VARCHAR(120),
  address TEXT,
  updated_by INT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
