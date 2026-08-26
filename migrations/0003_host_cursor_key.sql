-- Singleton Cursor API key for this host. Encrypted at rest with ENCRYPTION_KEY.
-- The raw key is never returned to the browser; chat and console use a host
-- session cookie (or the console login cookie) to authorize using it.
CREATE TABLE IF NOT EXISTS host_cursor_key (
  id TEXT PRIMARY KEY,
  cursor_user_id TEXT,
  cursor_email TEXT,
  cursor_name TEXT,
  cursor_key_name TEXT,
  cursor_api_key_ciphertext TEXT NOT NULL,
  cursor_api_key_iv TEXT NOT NULL,
  cursor_api_key_hint TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
