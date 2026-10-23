-- New Joinee allocation emails + location SPOCs (idempotent; safe to re-run).

-- Engineers responsible for handing over assets at each location (imported from the
-- "Location SPOC details" sheet). A location may have several SPOCs.
CREATE TABLE IF NOT EXISTS location_spocs (
    id SERIAL PRIMARY KEY,
    location_id INT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (location_id, email)
);
CREATE INDEX IF NOT EXISTS idx_location_spocs_location ON location_spocs(location_id);

-- Every outbound email attempt (sent / failed / skipped) for audit and resend.
CREATE TABLE IF NOT EXISTS email_log (
    id SERIAL PRIMARY KEY,
    type VARCHAR(50) NOT NULL,
    to_email VARCHAR(255),
    cc_emails TEXT,
    subject VARCHAR(255),
    body_text TEXT,
    status VARCHAR(20) NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
    error TEXT,
    related_type VARCHAR(50),
    related_id INT,
    created_by INT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_email_log_related ON email_log(related_type, related_id, created_at DESC);
