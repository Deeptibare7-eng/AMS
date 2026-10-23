-- Email is optional for employee records: the Asset Data register has no email column, so
-- employees it creates have no address until a real one is known. Accounts that sign in
-- still need one (enforced in userService). UNIQUE (email) allows any number of NULLs.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
