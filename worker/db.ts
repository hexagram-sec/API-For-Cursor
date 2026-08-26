import { accountIdForCursor, apiKeyPrefix, decryptText, encryptText, randomToken, sha256Hex } from "./crypto";
import type {
  AccountRow,
  ApiKeyRow,
  AuthenticatedAccount,
  CursorKeyRecord,
  CursorKeyRow,
  CursorMe,
  Env,
  HostCursorKeyMeta,
  HostCursorKeyRow,
  RelayKeyRow,
  RelayKeyView,
  ResolvedRelayKey
} from "./types";

export const HOST_CURSOR_KEY_ID = "default";
export const CONSOLE_SETTINGS_ID = "default";

export interface SignupRecord {
  account: AccountRow;
  proxyApiKey: string;
}

export async function saveSignup(env: Env, cursorApiKey: string, me: CursorMe): Promise<SignupRecord> {
  const secret = requireEncryptionSecret(env);
  const now = new Date().toISOString();
  const cursorUserId = me.userId === undefined ? null : String(me.userId);
  const cursorEmail = me.userEmail || null;
  const cursorName = [me.userFirstName, me.userLastName].filter(Boolean).join(" ").trim() || me.apiKeyName || null;
  const accountId = await accountIdForCursor(cursorUserId, cursorEmail, await sha256Hex(cursorApiKey));
  const encrypted = await encryptText(cursorApiKey, secret);
  const hint = cursorApiKey.slice(-4);
  const account: AccountRow = {
    id: accountId,
    cursor_user_id: cursorUserId,
    cursor_email: cursorEmail,
    cursor_name: cursorName,
    cursor_api_key_ciphertext: encrypted.ciphertext,
    cursor_api_key_iv: encrypted.iv,
    cursor_api_key_hint: hint,
    waitlist_opt_in: 0,
    created_at: now,
    updated_at: now
  };

  await env.DB.prepare(
    `INSERT INTO accounts (
      id, cursor_user_id, cursor_email, cursor_name, cursor_api_key_ciphertext,
      cursor_api_key_iv, cursor_api_key_hint, waitlist_opt_in, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      cursor_user_id = excluded.cursor_user_id,
      cursor_email = excluded.cursor_email,
      cursor_name = excluded.cursor_name,
      cursor_api_key_ciphertext = excluded.cursor_api_key_ciphertext,
      cursor_api_key_iv = excluded.cursor_api_key_iv,
      cursor_api_key_hint = excluded.cursor_api_key_hint,
      waitlist_opt_in = excluded.waitlist_opt_in,
      updated_at = excluded.updated_at`
  )
    .bind(
      account.id,
      account.cursor_user_id,
      account.cursor_email,
      account.cursor_name,
      account.cursor_api_key_ciphertext,
      account.cursor_api_key_iv,
      account.cursor_api_key_hint,
      account.waitlist_opt_in,
      account.created_at,
      account.updated_at
    )
    .run();

  const proxyApiKey = randomToken("cmp");
  const keyHash = await sha256Hex(proxyApiKey);
  await env.DB.prepare(
    `INSERT INTO api_keys (id, account_id, prefix, key_hash, name, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(`key_${crypto.randomUUID()}`, account.id, apiKeyPrefix(proxyApiKey), keyHash, "default", now)
    .run();

  return { account, proxyApiKey };
}

export async function authenticateProxyKey(env: Env, proxyApiKey: string): Promise<AuthenticatedAccount | null> {
  const keyHash = await sha256Hex(proxyApiKey);
  const apiKey = await env.DB.prepare(
    `SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL LIMIT 1`
  )
    .bind(keyHash)
    .first<ApiKeyRow>();
  if (!apiKey) return null;

  const account = await env.DB.prepare(`SELECT * FROM accounts WHERE id = ? LIMIT 1`)
    .bind(apiKey.account_id)
    .first<AccountRow>();
  if (!account) return null;

  const cursorApiKey = await decryptText(
    account.cursor_api_key_ciphertext,
    account.cursor_api_key_iv,
    requireEncryptionSecret(env)
  );
  await env.DB.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), apiKey.id)
    .run();

  return { account, apiKey, cursorApiKey };
}

export async function saveHostCursorKey(env: Env, cursorApiKey: string, me: CursorMe): Promise<HostCursorKeyMeta> {
  const secret = requireEncryptionSecret(env);
  const now = new Date().toISOString();
  const encrypted = await encryptText(cursorApiKey, secret);
  const existing = await env.DB.prepare(`SELECT created_at FROM host_cursor_key WHERE id = ? LIMIT 1`)
    .bind(HOST_CURSOR_KEY_ID)
    .first<{ created_at: string }>();
  const createdAt = existing?.created_at || now;
  const cursorName = [me.userFirstName, me.userLastName].filter(Boolean).join(" ").trim() || null;
  const row: HostCursorKeyRow = {
    id: HOST_CURSOR_KEY_ID,
    cursor_user_id: me.userId === undefined ? null : String(me.userId),
    cursor_email: me.userEmail || null,
    cursor_name: cursorName,
    cursor_key_name: me.apiKeyName || null,
    cursor_api_key_ciphertext: encrypted.ciphertext,
    cursor_api_key_iv: encrypted.iv,
    cursor_api_key_hint: cursorApiKey.slice(-4),
    created_at: createdAt,
    updated_at: now
  };

  await env.DB.prepare(
    `INSERT INTO host_cursor_key (
      id, cursor_user_id, cursor_email, cursor_name, cursor_key_name,
      cursor_api_key_ciphertext, cursor_api_key_iv, cursor_api_key_hint, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      cursor_user_id = excluded.cursor_user_id,
      cursor_email = excluded.cursor_email,
      cursor_name = excluded.cursor_name,
      cursor_key_name = excluded.cursor_key_name,
      cursor_api_key_ciphertext = excluded.cursor_api_key_ciphertext,
      cursor_api_key_iv = excluded.cursor_api_key_iv,
      cursor_api_key_hint = excluded.cursor_api_key_hint,
      updated_at = excluded.updated_at`
  )
    .bind(
      row.id,
      row.cursor_user_id,
      row.cursor_email,
      row.cursor_name,
      row.cursor_key_name,
      row.cursor_api_key_ciphertext,
      row.cursor_api_key_iv,
      row.cursor_api_key_hint,
      row.created_at,
      row.updated_at
    )
    .run();

  return hostCursorKeyMeta(row);
}

export async function getHostCursorKeyMeta(env: Env): Promise<HostCursorKeyMeta | null> {
  const row = await loadHostCursorKeyRow(env);
  return row ? hostCursorKeyMeta(row) : null;
}

export async function loadHostCursorKey(env: Env): Promise<(HostCursorKeyMeta & { cursorApiKey: string }) | null> {
  const row = await loadHostCursorKeyRow(env);
  if (!row) return null;
  const cursorApiKey = await decryptText(row.cursor_api_key_ciphertext, row.cursor_api_key_iv, requireEncryptionSecret(env));
  return { ...hostCursorKeyMeta(row), cursorApiKey };
}

export async function clearHostCursorKey(env: Env): Promise<void> {
  await env.DB.prepare(`DELETE FROM host_cursor_key WHERE id = ?`).bind(HOST_CURSOR_KEY_ID).run();
}

async function loadHostCursorKeyRow(env: Env): Promise<HostCursorKeyRow | null> {
  return env.DB.prepare(`SELECT * FROM host_cursor_key WHERE id = ? LIMIT 1`).bind(HOST_CURSOR_KEY_ID).first<HostCursorKeyRow>();
}

function hostCursorKeyMeta(row: HostCursorKeyRow): HostCursorKeyMeta {
  return {
    hint: row.cursor_api_key_hint,
    email: row.cursor_email,
    name: row.cursor_name,
    keyName: row.cursor_key_name
  };
}

/* ---------- Multiple Cursor tokens ---------- */

const CURSOR_KEY_ID_PREFIX = "ck";
const RELAY_KEY_ID_PREFIX = "rk";

/** Deterministic id so re-adding the same Cursor token updates in place. */
async function deriveCursorKeyId(me: CursorMe, cursorApiKey: string): Promise<string> {
  const userId = me.userId === undefined ? null : String(me.userId);
  const basis = userId
    ? `cursor-user:${userId}`
    : me.userEmail
      ? `cursor-email:${me.userEmail.toLowerCase()}`
      : `cursor-key:${await sha256Hex(cursorApiKey)}`;
  return `${CURSOR_KEY_ID_PREFIX}_${(await sha256Hex(basis)).slice(0, 24)}`;
}

export async function listCursorKeys(env: Env): Promise<CursorKeyRecord[]> {
  const result = await env.DB.prepare(
    `SELECT c.*, (
       SELECT COUNT(*) FROM relay_keys r WHERE r.cursor_key_id = c.id AND r.revoked_at IS NULL
     ) AS relay_count
     FROM cursor_keys c
     ORDER BY c.is_default DESC, c.created_at ASC`
  ).all<CursorKeyRow & { relay_count: number }>();
  return (result.results ?? []).map((row) => cursorKeyRecord(row, row.relay_count));
}

export async function getCursorKeyRecord(env: Env, id: string): Promise<CursorKeyRecord | null> {
  const row = await env.DB.prepare(`SELECT * FROM cursor_keys WHERE id = ? LIMIT 1`).bind(id).first<CursorKeyRow>();
  return row ? cursorKeyRecord(row, 0) : null;
}

export async function getCursorKey(env: Env, id: string): Promise<(CursorKeyRecord & { cursorApiKey: string }) | null> {
  const row = await env.DB.prepare(`SELECT * FROM cursor_keys WHERE id = ? LIMIT 1`).bind(id).first<CursorKeyRow>();
  if (!row) return null;
  const cursorApiKey = await decryptText(row.cursor_api_key_ciphertext, row.cursor_api_key_iv, requireEncryptionSecret(env));
  return { ...cursorKeyRecord(row, 0), cursorApiKey };
}

/** Cookie-less browser requests (chat/lab) fall back to the default token. */
export async function getDefaultCursorKey(env: Env): Promise<(CursorKeyRecord & { cursorApiKey: string }) | null> {
  const row =
    (await env.DB.prepare(`SELECT * FROM cursor_keys WHERE is_default = 1 LIMIT 1`).first<CursorKeyRow>()) ??
    (await env.DB.prepare(`SELECT * FROM cursor_keys ORDER BY created_at ASC LIMIT 1`).first<CursorKeyRow>());
  if (!row) return null;
  const cursorApiKey = await decryptText(row.cursor_api_key_ciphertext, row.cursor_api_key_iv, requireEncryptionSecret(env));
  return { ...cursorKeyRecord(row, 0), cursorApiKey };
}

export async function upsertCursorKey(
  env: Env,
  cursorApiKey: string,
  me: CursorMe,
  opts: { makeDefault?: boolean } = {}
): Promise<CursorKeyRecord> {
  const secret = requireEncryptionSecret(env);
  const now = new Date().toISOString();
  const id = await deriveCursorKeyId(me, cursorApiKey);
  const encrypted = await encryptText(cursorApiKey, secret);
  const cursorName = [me.userFirstName, me.userLastName].filter(Boolean).join(" ").trim() || null;
  const existing = await env.DB.prepare(`SELECT created_at FROM cursor_keys WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<{ created_at: string }>();
  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cursor_keys`).first<{ n: number }>();
  const makeDefault = opts.makeDefault || (total?.n ?? 0) === 0;

  await env.DB.prepare(
    `INSERT INTO cursor_keys (
       id, cursor_user_id, cursor_email, cursor_name, cursor_key_name,
       cursor_api_key_ciphertext, cursor_api_key_iv, cursor_api_key_hint,
       is_default, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       cursor_user_id = excluded.cursor_user_id,
       cursor_email = excluded.cursor_email,
       cursor_name = excluded.cursor_name,
       cursor_key_name = excluded.cursor_key_name,
       cursor_api_key_ciphertext = excluded.cursor_api_key_ciphertext,
       cursor_api_key_iv = excluded.cursor_api_key_iv,
       cursor_api_key_hint = excluded.cursor_api_key_hint,
       updated_at = excluded.updated_at`
  )
    .bind(
      id,
      me.userId === undefined ? null : String(me.userId),
      me.userEmail || null,
      cursorName,
      me.apiKeyName || null,
      encrypted.ciphertext,
      encrypted.iv,
      cursorApiKey.slice(-4),
      makeDefault ? 1 : 0,
      existing?.created_at || now,
      now
    )
    .run();

  if (makeDefault) await setDefaultCursorKey(env, id);
  const record = await getCursorKeyRecord(env, id);
  if (!record) throw new Error("Failed to persist Cursor key");
  return record;
}

export async function deleteCursorKey(env: Env, id: string): Promise<void> {
  const row = await env.DB.prepare(`SELECT is_default FROM cursor_keys WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<{ is_default: number }>();
  await env.DB.prepare(`DELETE FROM cursor_keys WHERE id = ?`).bind(id).run();
  if (row?.is_default) {
    const next = await env.DB.prepare(`SELECT id FROM cursor_keys ORDER BY created_at ASC LIMIT 1`).first<{ id: string }>();
    if (next) await setDefaultCursorKey(env, next.id);
  }
}

export async function setDefaultCursorKey(env: Env, id: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`UPDATE cursor_keys SET is_default = 0 WHERE is_default = 1`),
    env.DB.prepare(`UPDATE cursor_keys SET is_default = 1, updated_at = ? WHERE id = ?`).bind(new Date().toISOString(), id)
  ]);
}

/** Replace the stored token for an existing row in place (id and relay keys preserved). */
export async function updateCursorKeyValue(
  env: Env,
  id: string,
  cursorApiKey: string,
  me: CursorMe
): Promise<CursorKeyRecord | null> {
  const row = await env.DB.prepare(`SELECT id FROM cursor_keys WHERE id = ? LIMIT 1`).bind(id).first<{ id: string }>();
  if (!row) return null;
  const secret = requireEncryptionSecret(env);
  const encrypted = await encryptText(cursorApiKey, secret);
  const cursorName = [me.userFirstName, me.userLastName].filter(Boolean).join(" ").trim() || null;
  await env.DB.prepare(
    `UPDATE cursor_keys SET
       cursor_user_id = ?, cursor_email = ?, cursor_name = ?, cursor_key_name = ?,
       cursor_api_key_ciphertext = ?, cursor_api_key_iv = ?, cursor_api_key_hint = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(
      me.userId === undefined ? null : String(me.userId),
      me.userEmail || null,
      cursorName,
      me.apiKeyName || null,
      encrypted.ciphertext,
      encrypted.iv,
      cursorApiKey.slice(-4),
      new Date().toISOString(),
      id
    )
    .run();
  return getCursorKeyRecord(env, id);
}

function cursorKeyRecord(row: CursorKeyRow, relayCount: number): CursorKeyRecord {
  return {
    id: row.id,
    hint: row.cursor_api_key_hint,
    email: row.cursor_email,
    name: row.cursor_name,
    keyName: row.cursor_key_name,
    isDefault: Boolean(row.is_default),
    relayCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/* ---------- Relay keys (sk-...) ---------- */

/** OpenAI-style `sk-...`: reuse `randomToken` and swap the `_` separator. */
function newRelayKey(): string {
  return randomToken("sk").replace("_", "-");
}

export async function listRelayKeys(env: Env): Promise<RelayKeyView[]> {
  const secret = requireEncryptionSecret(env);
  const result = await env.DB.prepare(`SELECT * FROM relay_keys WHERE revoked_at IS NULL ORDER BY created_at ASC`).all<RelayKeyRow>();
  const rows = result.results ?? [];
  return Promise.all(rows.map(async (row) => relayKeyView(row, await decryptText(row.key_ciphertext, row.key_iv, secret))));
}

export async function createRelayKey(env: Env, cursorKeyId: string, name: string): Promise<RelayKeyView> {
  const secret = requireEncryptionSecret(env);
  const now = new Date().toISOString();
  const raw = newRelayKey();
  const encrypted = await encryptText(raw, secret);
  const id = `${RELAY_KEY_ID_PREFIX}_${crypto.randomUUID()}`;
  const label = name.trim() || "relay";
  await env.DB.prepare(
    `INSERT INTO relay_keys (id, cursor_key_id, name, key_ciphertext, key_iv, key_hash, key_hint, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
  )
    .bind(id, cursorKeyId, label, encrypted.ciphertext, encrypted.iv, await sha256Hex(raw), raw.slice(-4), now)
    .run();
  return { id, cursorKeyId, name: label, key: raw, hint: raw.slice(-4), enabled: true, createdAt: now, lastUsedAt: null };
}

export async function updateRelayKey(
  env: Env,
  id: string,
  patch: { name?: string; enabled?: boolean; regenerate?: boolean }
): Promise<RelayKeyView | null> {
  const secret = requireEncryptionSecret(env);
  const row = await env.DB.prepare(`SELECT * FROM relay_keys WHERE id = ? AND revoked_at IS NULL LIMIT 1`).bind(id).first<RelayKeyRow>();
  if (!row) return null;

  let raw = await decryptText(row.key_ciphertext, row.key_iv, secret);
  let ciphertext = row.key_ciphertext;
  let iv = row.key_iv;
  let hash = row.key_hash;
  let hint = row.key_hint;
  if (patch.regenerate) {
    raw = newRelayKey();
    const enc = await encryptText(raw, secret);
    ciphertext = enc.ciphertext;
    iv = enc.iv;
    hash = await sha256Hex(raw);
    hint = raw.slice(-4);
  }
  const name = patch.name !== undefined ? patch.name.trim() || row.name : row.name;
  const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : row.enabled;
  await env.DB.prepare(
    `UPDATE relay_keys SET name = ?, enabled = ?, key_ciphertext = ?, key_iv = ?, key_hash = ?, key_hint = ? WHERE id = ?`
  )
    .bind(name, enabled, ciphertext, iv, hash, hint, id)
    .run();
  return {
    id,
    cursorKeyId: row.cursor_key_id,
    name,
    key: raw,
    hint,
    enabled: Boolean(enabled),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at
  };
}

export async function deleteRelayKey(env: Env, id: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM relay_keys WHERE id = ?`).bind(id).run();
}

export async function resolveRelayKey(env: Env, rawKey: string): Promise<ResolvedRelayKey | null> {
  const keyHash = await sha256Hex(rawKey);
  const row = await env.DB.prepare(`SELECT * FROM relay_keys WHERE key_hash = ? AND enabled = 1 AND revoked_at IS NULL LIMIT 1`)
    .bind(keyHash)
    .first<RelayKeyRow>();
  if (!row) return null;
  const cursor = await env.DB.prepare(`SELECT * FROM cursor_keys WHERE id = ? LIMIT 1`).bind(row.cursor_key_id).first<CursorKeyRow>();
  if (!cursor) return null;
  const cursorApiKey = await decryptText(cursor.cursor_api_key_ciphertext, cursor.cursor_api_key_iv, requireEncryptionSecret(env));
  await env.DB.prepare(`UPDATE relay_keys SET last_used_at = ? WHERE id = ?`).bind(new Date().toISOString(), row.id).run();
  return { cursorKeyId: cursor.id, relayKeyId: row.id, cursorApiKey };
}

function relayKeyView(row: RelayKeyRow, key: string): RelayKeyView {
  return {
    id: row.id,
    cursorKeyId: row.cursor_key_id,
    name: row.name,
    key,
    hint: row.key_hint,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at
  };
}

export async function createRequestLog(
  env: Env,
  input: {
    accountId: string;
    endpoint: string;
    model?: string;
    status: string;
    promptChars?: number;
    completionChars?: number;
    cursorAgentId?: string;
    cursorRunId?: string;
    error?: string;
    completedAt?: string;
  }
): Promise<string> {
  const id = `req_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO request_logs (
      id, account_id, endpoint, model, cursor_agent_id, cursor_run_id, status,
      prompt_chars, completion_chars, error, created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      input.accountId,
      input.endpoint,
      input.model ?? null,
      input.cursorAgentId ?? null,
      input.cursorRunId ?? null,
      input.status,
      input.promptChars ?? 0,
      input.completionChars ?? 0,
      input.error ?? null,
      new Date().toISOString(),
      input.completedAt ?? null
    )
    .run();
  return id;
}

export async function completeRequestLog(
  env: Env,
  id: string,
  input: { status: string; completionChars?: number; cursorAgentId?: string; cursorRunId?: string; error?: string }
): Promise<void> {
  await env.DB.prepare(
    `UPDATE request_logs
     SET status = ?, completion_chars = ?, cursor_agent_id = COALESCE(?, cursor_agent_id),
         cursor_run_id = COALESCE(?, cursor_run_id), error = ?, completed_at = ?
     WHERE id = ?`
  )
    .bind(
      input.status,
      input.completionChars ?? 0,
      input.cursorAgentId ?? null,
      input.cursorRunId ?? null,
      input.error ?? null,
      new Date().toISOString(),
      id
    )
    .run();
}

export async function getConsolePasswordHash(env: Env): Promise<string | null> {
  const row = await env.DB.prepare("SELECT password_hash FROM console_settings WHERE id = ?")
    .bind(CONSOLE_SETTINGS_ID)
    .first<{ password_hash: string }>();
  const hash = row?.password_hash?.trim();
  return hash || null;
}

export async function setConsolePasswordHash(env: Env, passwordHash: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO console_settings (id, password_hash, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at`
  )
    .bind(CONSOLE_SETTINGS_ID, passwordHash, new Date().toISOString())
    .run();
}

function requireEncryptionSecret(env: Env): string {
  if (!env.ENCRYPTION_KEY || env.ENCRYPTION_KEY.trim().length < 16) {
    throw new Error("ENCRYPTION_KEY must be configured before storing Cursor API keys");
  }
  return env.ENCRYPTION_KEY;
}
