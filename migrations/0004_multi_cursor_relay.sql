-- Multiple Cursor tokens, each able to mint several OpenAI-style relay keys.
-- Relay keys are stored encrypted (so the admin can reveal the plaintext for
-- integration snippets) plus a SHA-256 hash for O(1) lookup during auth.
CREATE TABLE IF NOT EXISTS cursor_keys (
  id TEXT PRIMARY KEY,
  cursor_user_id TEXT,
  cursor_email TEXT,
  cursor_name TEXT,
  cursor_key_name TEXT,
  cursor_api_key_ciphertext TEXT NOT NULL,
  cursor_api_key_iv TEXT NOT NULL,
  cursor_api_key_hint TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS relay_keys (
  id TEXT PRIMARY KEY,
  cursor_key_id TEXT NOT NULL REFERENCES cursor_keys(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_ciphertext TEXT NOT NULL,
  key_iv TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_hint TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_relay_keys_cursor_key
ON relay_keys(cursor_key_id);

-- Carry the legacy singleton host key over as the default Cursor token. The
-- encryption scheme is unchanged, so the ciphertext/iv columns copy directly.
INSERT OR IGNORE INTO cursor_keys (
  id, cursor_user_id, cursor_email, cursor_name, cursor_key_name,
  cursor_api_key_ciphertext, cursor_api_key_iv, cursor_api_key_hint,
  is_default, created_at, updated_at
)
SELECT
  'ck_legacy_default', cursor_user_id, cursor_email, cursor_name, cursor_key_name,
  cursor_api_key_ciphertext, cursor_api_key_iv, cursor_api_key_hint,
  1, created_at, updated_at
FROM host_cursor_key
WHERE id = 'default';
