import type { ProbeOutcome, ProbeStatus } from "./lab-probe";

const STORAGE_KEY = "api-for-cursor.model-status.v1";
export const MODEL_STATUS_CHANGED = "model-status:changed";

export type SettledProbeStatus = Extract<ProbeStatus, "ok" | "error">;

export interface StoredProbeOutcome extends ProbeOutcome {
  status: SettledProbeStatus;
  testedAt: number;
}

interface StatusStore {
  relays: Record<string, Record<string, StoredProbeOutcome>>;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

let storageOverride: StorageLike | null | undefined;
let inflight = new Map<string, ProbeOutcome>();

export function setModelStatusStorageForTest(storage: StorageLike | null): void {
  storageOverride = storage;
  inflight = new Map();
}

export function parseStatusStore(raw: string | null): StatusStore {
  if (!raw) return { relays: {} };
  try {
    const parsed = JSON.parse(raw) as { relays?: unknown };
    if (!parsed || typeof parsed !== "object" || !parsed.relays || typeof parsed.relays !== "object") {
      return { relays: {} };
    }
    const relays: StatusStore["relays"] = {};
    for (const [relayId, models] of Object.entries(parsed.relays as Record<string, unknown>)) {
      if (!relayId || !models || typeof models !== "object") continue;
      const entries: Record<string, StoredProbeOutcome> = {};
      for (const [modelId, value] of Object.entries(models as Record<string, unknown>)) {
        const record = asStoredOutcome(modelId, value);
        if (record) entries[modelId] = record;
      }
      if (Object.keys(entries).length) relays[relayId] = entries;
    }
    return { relays };
  } catch {
    return { relays: {} };
  }
}

export function isSettledStatus(status: ProbeStatus): status is SettledProbeStatus {
  return status === "ok" || status === "error";
}

/** Last completed probe for a model, overlaid with an in-flight check when one is running. */
export function modelOutcome(model: string, relayId: string | null): ProbeOutcome | undefined {
  if (!relayId) return undefined;
  return modelOutcomes(relayId).get(model);
}

export function modelOutcomes(relayId: string | null): Map<string, ProbeOutcome> {
  const map = new Map<string, ProbeOutcome>();
  if (!relayId) return map;
  const stored = readStore().relays[relayId] ?? {};
  for (const [id, record] of Object.entries(stored)) map.set(id, record);
  for (const [key, outcome] of inflight) {
    if (key.startsWith(`${relayId}\t`)) map.set(outcome.model, outcome);
  }
  return map;
}

export function markModelCheck(model: string, status: "queued" | "running", relayId: string | null): void {
  if (!relayId) return;
  inflight.set(inflightKey(relayId, model), { model, status });
  emit();
}

export function recordModelCheck(outcome: ProbeOutcome, relayId: string | null, now = Date.now()): void {
  if (!relayId) return;
  inflight.delete(inflightKey(relayId, outcome.model));
  if (isSettledStatus(outcome.status)) {
    const store = readStore();
    const bucket = store.relays[relayId] ?? (store.relays[relayId] = {});
    bucket[outcome.model] = {
      model: outcome.model,
      status: outcome.status,
      httpStatus: outcome.httpStatus,
      ms: outcome.ms,
      reply: trimText(outcome.reply),
      error: trimText(outcome.error),
      testedAt: now
    };
    writeStore(store);
  }
  emit();
}

/** Drop an in-flight overlay so the last settled result shows again. */
export function restoreModelCheck(model: string, relayId: string | null): void {
  if (!relayId) return;
  inflight.delete(inflightKey(relayId, model));
  emit();
}

export function settledCount(modelIds: readonly string[], relayId: string | null): { ok: number; error: number; tested: number } {
  let ok = 0;
  let error = 0;
  const outcomes = modelOutcomes(relayId);
  for (const id of modelIds) {
    const outcome = outcomes.get(id);
    if (outcome?.status === "ok") ok += 1;
    else if (outcome?.status === "error") error += 1;
  }
  return { ok, error, tested: ok + error };
}

function inflightKey(relayId: string, model: string): string {
  return `${relayId}\t${model}`;
}

function readStore(): StatusStore {
  return parseStatusStore(readRaw());
}

function writeStore(store: StatusStore): void {
  const raw = JSON.stringify(store);
  const storage = resolveStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, raw);
  } catch {
    /* quota / private mode */
  }
}

function readRaw(): string | null {
  const storage = resolveStorage();
  if (!storage) return null;
  try {
    return storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function resolveStorage(): StorageLike | null {
  if (storageOverride !== undefined) return storageOverride;
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function asStoredOutcome(modelId: string, value: unknown): StoredProbeOutcome | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.status !== "ok" && raw.status !== "error") return null;
  const model = typeof raw.model === "string" && raw.model.trim() ? raw.model : modelId;
  const testedAt = typeof raw.testedAt === "number" && Number.isFinite(raw.testedAt) ? raw.testedAt : 0;
  const record: StoredProbeOutcome = { model, status: raw.status, testedAt };
  if (typeof raw.httpStatus === "number") record.httpStatus = raw.httpStatus;
  if (typeof raw.ms === "number") record.ms = raw.ms;
  if (typeof raw.reply === "string") record.reply = raw.reply;
  if (typeof raw.error === "string") record.error = raw.error;
  return record;
}

function trimText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 280 ? `${trimmed.slice(0, 277)}…` : trimmed;
}

function emit(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(MODEL_STATUS_CHANGED));
}
