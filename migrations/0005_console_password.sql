-- Console sign-in password, stored as SHA-256 hex. CONSOLE_PASSWORD in env is
-- only used to bootstrap this row on first successful login.
CREATE TABLE IF NOT EXISTS console_settings (
  id TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
