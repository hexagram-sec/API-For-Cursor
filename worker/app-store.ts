import type { AccessLogRow, AppSettingsRow, Env } from "./types";

export const ACCESS_LOG_CAP = 2000;

export async function listAppSettings(env: Env): Promise<Map<string, string>> {
  const { results } = await env.DB.prepare("SELECT * FROM app_settings").all<AppSettingsRow>();
  const map = new Map<string, string>();
  for (const row of results ?? []) map.set(row.key, row.value);
  return map;
}

export async function upsertAppSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(key, value, new Date().toISOString())
    .run();
}

/** Insert only if missing so ENCRYPTION_KEY is never rotated after the first write. */
export async function insertAppSettingIfAbsent(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO NOTHING`
  )
    .bind(key, value, new Date().toISOString())
    .run();
}

export interface AccessLogInput {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  clientIp?: string | null;
  relayKeyId?: string | null;
  cursorKeyId?: string | null;
  model?: string | null;
  error?: string | null;
}

export async function insertAccessLog(env: Env, input: AccessLogInput): Promise<void> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO access_logs (
      id, created_at, method, path, status, duration_ms, client_ip,
      relay_key_id, cursor_key_id, model, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      new Date().toISOString(),
      input.method,
      input.path,
      input.status,
      input.durationMs,
      input.clientIp ?? null,
      input.relayKeyId ?? null,
      input.cursorKeyId ?? null,
      input.model ?? null,
      input.error ?? null
    )
    .run();

  const countRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM access_logs").first<{ n: number }>();
  const n = Number(countRow?.n ?? 0);
  if (n > ACCESS_LOG_CAP) {
    await env.DB.prepare(
      `DELETE FROM access_logs WHERE id IN (
        SELECT id FROM access_logs ORDER BY created_at ASC, id ASC LIMIT ?
      )`
    )
      .bind(n - ACCESS_LOG_CAP)
      .run();
  }
}

export async function listAccessLogs(
  env: Env,
  limit: number,
  offset: number,
  query = ""
): Promise<{ logs: AccessLogRow[]; total: number }> {
  const safeLimit = Math.min(Math.max(1, limit), 200);
  const safeOffset = Math.max(0, offset);
  const needle = query.trim().slice(0, 120);
  if (!needle) {
    const countRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM access_logs").first<{ n: number }>();
    const total = Number(countRow?.n ?? 0);
    const { results } = await env.DB.prepare(
      "SELECT * FROM access_logs ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
    )
      .bind(safeLimit, safeOffset)
      .all<AccessLogRow>();
    return { logs: results ?? [], total };
  }

  const like = `%${needle.replaceAll("%", "").replaceAll("_", "")}%`;
  const where =
    "path LIKE ? OR method LIKE ? OR CAST(status AS TEXT) LIKE ? OR IFNULL(model, '') LIKE ? OR IFNULL(error, '') LIKE ?";
  const countRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM access_logs WHERE ${where}`)
    .bind(like, like, like, like, like)
    .first<{ n: number }>();
  const total = Number(countRow?.n ?? 0);
  const { results } = await env.DB.prepare(
    `SELECT * FROM access_logs WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
  )
    .bind(like, like, like, like, like, safeLimit, safeOffset)
    .all<AccessLogRow>();
  return { logs: results ?? [], total };
}
