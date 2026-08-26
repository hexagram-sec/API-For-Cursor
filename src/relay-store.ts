/**
 * Shared "current relay key" state for the whole backend shell.
 *
 * Chat, Lab and the model-validation view all authenticate their `/v1/*` calls
 * with a relay key (`sk-…`). The shell's sidebar exposes a single selector; the
 * chosen key id is persisted here and mirrored into `localStorage` so a reload
 * keeps the same selection.
 */

export interface RelayOption {
  id: string;
  name: string;
  key: string;
  enabled: boolean;
}

const STORAGE_KEY = "api-for-cursor.relay-key-id";

let options: RelayOption[] = [];
let baseUrl = `${window.location.origin}/v1`;
let selectedId: string | null = readStoredId();

function readStoredId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function persist(): void {
  try {
    if (selectedId) localStorage.setItem(STORAGE_KEY, selectedId);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable - keep the in-memory selection only */
  }
}

/**
 * Pulls the relay-key list from the admin API. When a password is set this
 * requires a console session, so callers must only invoke it after sign-in.
 * Returns the HTTP status so the shell can drop back to the login view on 401.
 */
export async function refreshRelayKeys(): Promise<{ status: number }> {
  try {
    const response = await fetch("/api/admin/relay-keys", { credentials: "same-origin" });
    if (!response.ok) {
      if (response.status === 401) options = [];
      return { status: response.status };
    }
    const payload = (await response.json()) as { keys?: RelayOption[]; baseUrl?: string };
    options = (payload.keys ?? []).filter((entry) => entry.enabled);
    if (payload.baseUrl) baseUrl = payload.baseUrl;
    if (!selectedId || !options.some((entry) => entry.id === selectedId)) {
      selectedId = options[0]?.id ?? null;
      persist();
    }
    return { status: 200 };
  } catch {
    options = [];
    return { status: 0 };
  }
}

export function relayOptions(): RelayOption[] {
  return options;
}

export function selectedRelayId(): string | null {
  return selectedId;
}

export function selectedRelayKey(): string | null {
  return options.find((entry) => entry.id === selectedId)?.key ?? null;
}

export function selectedRelayName(): string | null {
  return options.find((entry) => entry.id === selectedId)?.name ?? null;
}

export function setSelectedRelay(id: string | null): void {
  selectedId = id && options.some((entry) => entry.id === id) ? id : null;
  persist();
}

export function hasRelayKey(): boolean {
  return selectedRelayKey() != null;
}

export function relayAuthHeaders(): Record<string, string> {
  const key = selectedRelayKey();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

export function relayBaseUrl(): string {
  return baseUrl;
}
