-- Security hardening (idempotent; safe to re-run).
-- must_change_password: set when an account signs in with a known default password
-- (seeded admin, bulk-imported users) or receives a one-time password; the app then
-- only allows the Profile page until the user sets a new password.
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
