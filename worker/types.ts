export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  ENCRYPTION_KEY?: string;
  CURSOR_API_BASE?: string;
  CURSOR_BACKEND_BASE_URL?: string;
  CURSOR_CHAT_ENDPOINT?: string;
  CURSOR_CLIENT_VERSION?: string;
  CURSOR_LOCAL_AGENT_ENDPOINT?: string;
  CURSOR_SDK_BRIDGE_TOKEN?: string;
  CURSOR_SDK_BRIDGE_TIMEOUT_MS?: string;
  CURSOR_SDK_BRIDGE_URL?: string;
  CURSOR_SDK_CLIENT_VERSION?: string;
  CONSOLE_PASSWORD?: string;
}

export interface Deps {
  fetch: typeof fetch;
  now: () => Date;
  randomUUID: () => `${string}-${string}-${string}-${string}-${string}`;
}

export interface CursorMe {
  apiKeyName: string;
  userId?: number;
  userEmail?: string;
  userFirstName?: string;
  userLastName?: string;
  createdAt: string;
}

export interface CursorKeyRow {
  id: string;
  cursor_user_id: string | null;
  cursor_email: string | null;
  cursor_name: string | null;
  cursor_key_name: string | null;
  cursor_api_key_ciphertext: string;
  cursor_api_key_iv: string;
  cursor_api_key_hint: string | null;
  is_default: number;
  created_at: string;
  updated_at: string;
}

export interface CursorKeyRecord {
  id: string;
  hint: string | null;
  email: string | null;
  name: string | null;
  keyName: string | null;
  isDefault: boolean;
  relayCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RelayKeyRow {
  id: string;
  cursor_key_id: string;
  name: string;
  key_ciphertext: string;
  key_iv: string;
  key_hash: string;
  key_hint: string | null;
  enabled: number;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface ConsoleSettingsRow {
  id: string;
  password_hash: string;
  updated_at: string;
}

export interface AppSettingsRow {
  key: string;
  value: string;
  updated_at: string;
}

export interface AccessLogRow {
  id: string;
  created_at: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  client_ip: string | null;
  relay_key_id: string | null;
  cursor_key_id: string | null;
  model: string | null;
  error: string | null;
}

/** Relay key view for the admin, including the revealed plaintext `sk-...`. */
export interface RelayKeyView {
  id: string;
  cursorKeyId: string;
  name: string;
  key: string;
  hint: string | null;
  enabled: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ResolvedRelayKey {
  cursorKeyId: string;
  relayKeyId: string;
  cursorApiKey: string;
}

export type CursorImage =
  | { url: string; dimension?: { width: number; height: number }; uuid?: string }
  | { data: string; mimeType: string; dimension?: { width: number; height: number }; uuid?: string };

export interface CursorPrompt {
  text: string;
  images?: CursorImage[];
  mode?: "ask" | "agent";
}

export interface CursorToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface CursorCompletion {
  requestId: string;
  conversationId: string;
  stream: Response;
}

export interface CompletionResult {
  id: string;
  model: string;
  created: number;
  text: string;
  promptChars: number;
  completionChars: number;
  cursorAgentId?: string;
  cursorRunId?: string;
}
