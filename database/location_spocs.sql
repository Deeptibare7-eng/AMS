-- Location SPOCs: users who look after one or more sites (the Location read from Machine Name,
-- see stockSiteService) and use the Location Workspace for those sites only. Idempotent.
CREATE TABLE IF NOT EXISTS site_spocs (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site VARCHAR(60) NOT NULL,
  phone VARCHAR(50),
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, site)
);
CREATE INDEX IF NOT EXISTS idx_site_spocs_site ON site_spocs (site);

-- Role for SPOC accounts: the same rights as employees. Everything a SPOC does in the Location
-- Workspace is checked against their own sites, so the role grants nothing global.
INSERT INTO roles (name, display_name, description, level)
VALUES ('location_spoc', 'Location SPOC', 'Looks after one or more sites: their stock, laptop allocation and new joiners there.', 10)
ON CONFLICT (name) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT s.id, rp.permission_id
  FROM roles s
  JOIN roles e ON e.name = 'employee'
  JOIN role_permissions rp ON rp.role_id = e.id
 WHERE s.name = 'location_spoc'
ON CONFLICT DO NOTHING;
