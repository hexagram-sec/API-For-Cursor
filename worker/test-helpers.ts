import type {
  AccessLogRow,
  AccountRow,
  ApiKeyRow,
  AppSettingsRow,
  ConsoleSettingsRow,
  CursorKeyRow,
  HostCursorKeyRow,
  RelayKeyRow
} from "./types";

export class FakeD1 {
  accounts = new Map<string, AccountRow>();
  apiKeys = new Map<string, ApiKeyRow>();
  requestLogs = new Map<string, Record<string, unknown>>();
  sdkSessions = new Map<string, Record<string, unknown>>();
  hostCursorKey = new Map<string, HostCursorKeyRow>();
  cursorKeys = new Map<string, CursorKeyRow>();
  relayKeys = new Map<string, RelayKeyRow>();
  consoleSettings = new Map<string, ConsoleSettingsRow>();
  appSettings = new Map<string, AppSettingsRow>();
  accessLogs = new Map<string, AccessLogRow>();

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

class FakeStatement {
  private values: unknown[] = [];

  constructor(private readonly db: FakeD1, private readonly sql: string) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async run() {
    const normalized = this.sql.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("INSERT INTO accounts")) {
      const [id, cursorUserId, cursorEmail, cursorName, ciphertext, iv, hint, waitlist, createdAt, updatedAt] = this.values;
      const existing = this.db.accounts.get(String(id));
      this.db.accounts.set(String(id), {
        id: String(id),
        cursor_user_id: nullable(cursorUserId),
        cursor_email: nullable(cursorEmail),
        cursor_name: nullable(cursorName),
        cursor_api_key_ciphertext: String(ciphertext),
        cursor_api_key_iv: String(iv),
        cursor_api_key_hint: nullable(hint),
        waitlist_opt_in: Number(waitlist),
        created_at: existing?.created_at || String(createdAt),
        updated_at: String(updatedAt)
      });
    } else if (normalized.startsWith("INSERT INTO api_keys")) {
      const [id, accountId, prefix, keyHash, name, createdAt] = this.values;
      this.db.apiKeys.set(String(id), {
        id: String(id),
        account_id: String(accountId),
        prefix: String(prefix),
        key_hash: String(keyHash),
        name: String(name),
        created_at: String(createdAt),
        last_used_at: null,
        revoked_at: null
      });
    } else if (normalized.startsWith("UPDATE api_keys SET last_used_at")) {
      const [lastUsedAt, id] = this.values;
      const row = this.db.apiKeys.get(String(id));
      if (row) row.last_used_at = String(lastUsedAt);
    } else if (normalized.startsWith("INSERT INTO request_logs")) {
      const [id, accountId, endpoint, model, cursorAgentId, cursorRunId, status, promptChars, completionChars, error, createdAt, completedAt] =
        this.values;
      this.db.requestLogs.set(String(id), {
        id,
        account_id: accountId,
        endpoint,
        model,
        cursor_agent_id: cursorAgentId,
        cursor_run_id: cursorRunId,
        status,
        prompt_chars: promptChars,
        completion_chars: completionChars,
        error,
        created_at: createdAt,
        completed_at: completedAt
      });
    } else if (normalized.startsWith("UPDATE request_logs")) {
      const [status, completionChars, cursorAgentId, cursorRunId, error, completedAt, id] = this.values;
      const row = this.db.requestLogs.get(String(id));
      if (row) {
        row.status = status;
        row.completion_chars = completionChars;
        row.cursor_agent_id = cursorAgentId || row.cursor_agent_id;
        row.cursor_run_id = cursorRunId || row.cursor_run_id;
        row.error = error;
        row.completed_at = completedAt;
      }
    } else if (normalized.startsWith("INSERT INTO sdk_sessions")) {
      const [id, ownerHash, sessionHash, agentId, createdAt, updatedAt] = this.values;
      const existing = this.db.sdkSessions.get(String(id));
      this.db.sdkSessions.set(String(id), {
        id,
        owner_hash: ownerHash,
        session_hash: sessionHash,
        agent_id: agentId,
        created_at: existing?.created_at || createdAt,
        updated_at: updatedAt
      });
    } else if (normalized.startsWith("DELETE FROM sdk_sessions")) {
      const [id] = this.values;
      this.db.sdkSessions.delete(String(id));
    } else if (normalized.startsWith("INSERT INTO host_cursor_key")) {
      const [id, cursorUserId, cursorEmail, cursorName, keyName, ciphertext, iv, hint, createdAt, updatedAt] =
        this.values;
      const existing = this.db.hostCursorKey.get(String(id));
      this.db.hostCursorKey.set(String(id), {
        id: String(id),
        cursor_user_id: nullable(cursorUserId),
        cursor_email: nullable(cursorEmail),
        cursor_name: nullable(cursorName),
        cursor_key_name: nullable(keyName),
        cursor_api_key_ciphertext: String(ciphertext),
        cursor_api_key_iv: String(iv),
        cursor_api_key_hint: nullable(hint),
        created_at: existing?.created_at || String(createdAt),
        updated_at: String(updatedAt)
      });
    } else if (normalized.startsWith("DELETE FROM host_cursor_key")) {
      const [id] = this.values;
      this.db.hostCursorKey.delete(String(id));
    } else if (normalized.startsWith("INSERT INTO cursor_keys")) {
      const [
        id,
        cursorUserId,
        cursorEmail,
        cursorName,
        keyName,
        ciphertext,
        iv,
        hint,
        isDefault,
        createdAt,
        updatedAt
      ] = this.values;
      const existing = this.db.cursorKeys.get(String(id));
      this.db.cursorKeys.set(String(id), {
        id: String(id),
        cursor_user_id: nullable(cursorUserId),
        cursor_email: nullable(cursorEmail),
        cursor_name: nullable(cursorName),
        cursor_key_name: nullable(keyName),
        cursor_api_key_ciphertext: String(ciphertext),
        cursor_api_key_iv: String(iv),
        cursor_api_key_hint: nullable(hint),
        // ON CONFLICT DO UPDATE leaves is_default untouched.
        is_default: existing ? existing.is_default : Number(isDefault),
        created_at: existing?.created_at || String(createdAt),
        updated_at: String(updatedAt)
      });
    } else if (normalized.startsWith("UPDATE cursor_keys SET is_default = 0")) {
      for (const row of this.db.cursorKeys.values()) row.is_default = 0;
    } else if (normalized.startsWith("UPDATE cursor_keys SET is_default = 1")) {
      const [updatedAt, id] = this.values;
      const row = this.db.cursorKeys.get(String(id));
      if (row) {
        row.is_default = 1;
        row.updated_at = String(updatedAt);
      }
    } else if (normalized.startsWith("UPDATE cursor_keys SET cursor_user_id")) {
      const [cursorUserId, cursorEmail, cursorName, keyName, ciphertext, iv, hint, updatedAt, id] = this.values;
      const row = this.db.cursorKeys.get(String(id));
      if (row) {
        row.cursor_user_id = nullable(cursorUserId);
        row.cursor_email = nullable(cursorEmail);
        row.cursor_name = nullable(cursorName);
        row.cursor_key_name = nullable(keyName);
        row.cursor_api_key_ciphertext = String(ciphertext);
        row.cursor_api_key_iv = String(iv);
        row.cursor_api_key_hint = nullable(hint);
        row.updated_at = String(updatedAt);
      }
    } else if (normalized.startsWith("DELETE FROM cursor_keys")) {
      const [id] = this.values;
      this.db.cursorKeys.delete(String(id));
    } else if (normalized.startsWith("INSERT INTO relay_keys")) {
      const [id, cursorKeyId, name, ciphertext, iv, keyHash, hint, createdAt] = this.values;
      this.db.relayKeys.set(String(id), {
        id: String(id),
        cursor_key_id: String(cursorKeyId),
        name: String(name),
        key_ciphertext: String(ciphertext),
        key_iv: String(iv),
        key_hash: String(keyHash),
        key_hint: nullable(hint),
        enabled: 1,
        created_at: String(createdAt),
        last_used_at: null,
        revoked_at: null
      });
    } else if (normalized.startsWith("UPDATE relay_keys SET name")) {
      const [name, enabled, ciphertext, iv, keyHash, hint, id] = this.values;
      const row = this.db.relayKeys.get(String(id));
      if (row) {
        row.name = String(name);
        row.enabled = Number(enabled);
        row.key_ciphertext = String(ciphertext);
        row.key_iv = String(iv);
        row.key_hash = String(keyHash);
        row.key_hint = nullable(hint);
      }
    } else if (normalized.startsWith("UPDATE relay_keys SET last_used_at")) {
      const [lastUsedAt, id] = this.values;
      const row = this.db.relayKeys.get(String(id));
      if (row) row.last_used_at = String(lastUsedAt);
    } else if (normalized.startsWith("DELETE FROM relay_keys")) {
      const [id] = this.values;
      this.db.relayKeys.delete(String(id));
    } else if (normalized.startsWith("INSERT INTO console_settings")) {
      const [id, passwordHash, updatedAt] = this.values;
      this.db.consoleSettings.set(String(id), {
        id: String(id),
        password_hash: String(passwordHash),
        updated_at: String(updatedAt)
      });
    } else if (normalized.startsWith("INSERT INTO app_settings")) {
      const [key, value, updatedAt] = this.values;
      const existing = this.db.appSettings.get(String(key));
      if (existing && normalized.includes("DO NOTHING")) {
        return { success: true };
      }
      this.db.appSettings.set(String(key), {
        key: String(key),
        value: String(value),
        updated_at: String(updatedAt)
      });
    } else if (normalized.startsWith("INSERT INTO access_logs")) {
      const [id, createdAt, method, path, status, durationMs, clientIp, relayKeyId, cursorKeyId, model, error] =
        this.values;
      this.db.accessLogs.set(String(id), {
        id: String(id),
        created_at: String(createdAt),
        method: String(method),
        path: String(path),
        status: Number(status),
        duration_ms: Number(durationMs),
        client_ip: nullable(clientIp),
        relay_key_id: nullable(relayKeyId),
        cursor_key_id: nullable(cursorKeyId),
        model: nullable(model),
        error: nullable(error)
      });
    } else if (normalized.startsWith("DELETE FROM access_logs WHERE id IN")) {
      const limit = Number(this.values[0] ?? 0);
      const oldest = [...this.db.accessLogs.values()]
        .slice()
        .sort((a, b) => compareStrings(a.created_at, b.created_at) || compareStrings(a.id, b.id))
        .slice(0, Math.max(0, limit));
      for (const row of oldest) this.db.accessLogs.delete(row.id);
    }
    return { success: true };
  }

  async all<T>(): Promise<{ results: T[] }> {
    const normalized = this.sql.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("SELECT c.*")) {
      const rows = [...this.db.cursorKeys.values()]
        .slice()
        .sort((a, b) => b.is_default - a.is_default || compareStrings(a.created_at, b.created_at))
        .map((row) => ({
          ...row,
          relay_count: [...this.db.relayKeys.values()].filter(
            (relay) => relay.cursor_key_id === row.id && !relay.revoked_at
          ).length
        }));
      return { results: rows as unknown as T[] };
    }
    if (normalized.startsWith("SELECT * FROM relay_keys WHERE revoked_at IS NULL")) {
      const rows = [...this.db.relayKeys.values()]
        .filter((row) => !row.revoked_at)
        .sort((a, b) => compareStrings(a.created_at, b.created_at));
      return { results: rows as unknown as T[] };
    }
    if (normalized.startsWith("SELECT * FROM app_settings")) {
      return { results: [...this.db.appSettings.values()] as unknown as T[] };
    }
    if (normalized.startsWith("SELECT * FROM access_logs")) {
      let rows = [...this.db.accessLogs.values()]
        .slice()
        .sort((a, b) => compareStrings(b.created_at, a.created_at) || compareStrings(b.id, a.id));
      if (normalized.includes("LIKE")) {
        const needle = String(this.values[0] ?? "")
          .replaceAll("%", "")
          .replaceAll("\\", "")
          .toLowerCase();
        rows = rows.filter((row) => accessLogMatches(row, needle));
      }
      const limit = Number(this.values.at(-2) ?? rows.length);
      const offset = Number(this.values.at(-1) ?? 0);
      return { results: rows.slice(offset, offset + limit) as unknown as T[] };
    }
    return { results: [] };
  }

  async first<T>() {
    const normalized = this.sql.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("SELECT * FROM api_keys WHERE key_hash")) {
      const [keyHash] = this.values;
      return ([...this.db.apiKeys.values()].find((row) => row.key_hash === keyHash && !row.revoked_at) || null) as T | null;
    }
    if (normalized.startsWith("SELECT * FROM accounts WHERE id")) {
      const [id] = this.values;
      return (this.db.accounts.get(String(id)) || null) as T | null;
    }
    if (normalized.startsWith("SELECT created_at FROM host_cursor_key")) {
      const [id] = this.values;
      const row = this.db.hostCursorKey.get(String(id));
      return (row ? { created_at: row.created_at } : null) as T | null;
    }
    if (normalized.startsWith("SELECT * FROM host_cursor_key WHERE id")) {
      const [id] = this.values;
      return (this.db.hostCursorKey.get(String(id)) || null) as T | null;
    }
    if (normalized.startsWith("SELECT agent_id, updated_at FROM sdk_sessions")) {
      const [id] = this.values;
      return (this.db.sdkSessions.get(String(id)) || null) as T | null;
    }
    if (normalized.startsWith("SELECT created_at FROM cursor_keys WHERE id")) {
      const [id] = this.values;
      const row = this.db.cursorKeys.get(String(id));
      return (row ? { created_at: row.created_at } : null) as T | null;
    }
    if (normalized.startsWith("SELECT COUNT(*) AS n FROM cursor_keys")) {
      return { n: this.db.cursorKeys.size } as unknown as T;
    }
    if (normalized.startsWith("SELECT is_default FROM cursor_keys WHERE id")) {
      const [id] = this.values;
      const row = this.db.cursorKeys.get(String(id));
      return (row ? { is_default: row.is_default } : null) as T | null;
    }
    if (normalized.startsWith("SELECT id FROM cursor_keys WHERE id")) {
      const [id] = this.values;
      const row = this.db.cursorKeys.get(String(id));
      return (row ? { id: row.id } : null) as T | null;
    }
    if (normalized.startsWith("SELECT id FROM cursor_keys ORDER BY created_at ASC")) {
      const row = earliest([...this.db.cursorKeys.values()]);
      return (row ? { id: row.id } : null) as T | null;
    }
    if (normalized.startsWith("SELECT * FROM cursor_keys WHERE is_default = 1")) {
      return ([...this.db.cursorKeys.values()].find((row) => row.is_default === 1) || null) as T | null;
    }
    if (normalized.startsWith("SELECT * FROM cursor_keys ORDER BY created_at ASC")) {
      return (earliest([...this.db.cursorKeys.values()]) || null) as T | null;
    }
    if (normalized.startsWith("SELECT * FROM cursor_keys WHERE id")) {
      const [id] = this.values;
      return (this.db.cursorKeys.get(String(id)) || null) as T | null;
    }
    if (normalized.startsWith("SELECT * FROM relay_keys WHERE key_hash")) {
      const [keyHash] = this.values;
      return (
        [...this.db.relayKeys.values()].find(
          (row) => row.key_hash === keyHash && row.enabled === 1 && !row.revoked_at
        ) || null
      ) as T | null;
    }
    if (normalized.startsWith("SELECT * FROM relay_keys WHERE id")) {
      const [id] = this.values;
      const row = this.db.relayKeys.get(String(id));
      return (row && !row.revoked_at ? row : null) as T | null;
    }
    if (normalized.startsWith("SELECT password_hash FROM console_settings WHERE id")) {
      const [id] = this.values;
      const row = this.db.consoleSettings.get(String(id));
      return (row ? { password_hash: row.password_hash } : null) as T | null;
    }
    if (normalized.startsWith("SELECT value FROM app_settings WHERE key")) {
      const [key] = this.values;
      const row = this.db.appSettings.get(String(key));
      return (row ? { value: row.value } : null) as T | null;
    }
    if (normalized.startsWith("SELECT COUNT(*) AS n FROM access_logs")) {
      if (normalized.includes("LIKE")) {
        const needle = String(this.values[0] ?? "")
          .replaceAll("%", "")
          .replaceAll("\\", "")
          .toLowerCase();
        return { n: [...this.db.accessLogs.values()].filter((row) => accessLogMatches(row, needle)).length } as unknown as T;
      }
      return { n: this.db.accessLogs.size } as unknown as T;
    }
    return null;
  }
}

function nullable(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function accessLogMatches(row: AccessLogRow, needle: string): boolean {
  if (!needle) return true;
  const haystack = [row.path, row.method, String(row.status), row.model ?? "", row.error ?? ""]
    .join("\n")
    .toLowerCase();
  return haystack.includes(needle);
}

function earliest(rows: CursorKeyRow[]): CursorKeyRow | undefined {
  return rows.slice().sort((a, b) => compareStrings(a.created_at, b.created_at))[0];
}

export interface FakeExecutionContext extends ExecutionContext {
  drain(): Promise<void>;
}

export function fakeCtx(): FakeExecutionContext {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil(promise: Promise<unknown>) {
      pending.push(Promise.resolve(promise).catch(() => undefined));
    },
    passThroughOnException() {
      return undefined;
    },
    props: {},
    drain() {
      return Promise.all(pending).then(() => undefined);
    }
  } as FakeExecutionContext;
}
