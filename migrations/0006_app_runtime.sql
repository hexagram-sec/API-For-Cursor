-- Runtime settings (replaces .dev.vars for business config) and request access logs.
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS access_logs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  client_ip TEXT,
  relay_key_id TEXT,
  cursor_key_id TEXT,
  model TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_access_logs_created_at ON access_logs (created_at DESC);
