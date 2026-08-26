/** Shared request/response helpers for the model lab UI. */

export const DEFAULT_PROBE_PROMPT = "Reply with the single word pong.";
export const DEFAULT_PROBE_CONCURRENCY = 8;
export const MAX_PROBE_CONCURRENCY = 64;

export interface ProbeModel {
  id: string;
  name: string;
}

export type ProbeStatus = "queued" | "running" | "ok" | "error" | "cancelled";

export interface ProbeOutcome {
  model: string;
  status: ProbeStatus;
  httpStatus?: number;
  ms?: number;
  reply?: string;
  error?: string;
}

export function probeRequestBody(model: string, prompt: string): Record<string, unknown> {
  return {
    model,
    stream: false,
    messages: [{ role: "user", content: prompt }]
  };
}

export function probeSessionKey(model: string, runId: string): string {
  return `lab:${model}:${runId}`;
}

type RandomCrypto = {
  randomUUID?: () => string;
  getRandomValues?: (bytes: Uint8Array) => Uint8Array;
};

/** `crypto.randomUUID` is missing on HTTP LAN IPs (not a secure context). */
export function randomId(webCrypto: RandomCrypto | undefined = globalThis.crypto): string {
  if (typeof webCrypto?.randomUUID === "function") return webCrypto.randomUUID();
  if (typeof webCrypto?.getRandomValues === "function") {
    const bytes = webCrypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `id-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

export function clampConcurrency(value: unknown, fallback = DEFAULT_PROBE_CONCURRENCY): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(MAX_PROBE_CONCURRENCY, Math.floor(parsed)));
}

export async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.min(clampConcurrency(concurrency), items.length);
  let cursor = 0;

  async function pump(): Promise<void> {
    while (true) {
      if (signal?.aborted) return;
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => pump()));
}

export async function probeModel(
  model: string,
  prompt: string,
  signal: AbortSignal,
  headers: Record<string, string> = {}
): Promise<ProbeOutcome> {
  const started = performance.now();
  try {
    const response = await fetch("/v1/chat/completions", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "x-session-affinity": probeSessionKey(model, randomId()),
        ...headers
      },
      body: JSON.stringify(probeRequestBody(model, prompt)),
      signal
    });
    const body = await response.text();
    return summarizeProbeResponse(model, response.status, body, Math.round(performance.now() - started));
  } catch (error) {
    const ms = Math.round(performance.now() - started);
    if (signal.aborted) return { model, status: "cancelled", ms };
    return {
      model,
      status: "error",
      ms,
      error: error instanceof Error ? error.message : "Request failed"
    };
  }
}

export function summarizeProbeResponse(model: string, httpStatus: number, body: string, ms: number): ProbeOutcome {
  const parsed = parseJson(body);
  if (httpStatus < 200 || httpStatus >= 300) {
    return {
      model,
      status: "error",
      httpStatus,
      ms,
      error: errorMessageFromPayload(parsed, body) || `HTTP ${httpStatus}`
    };
  }
  const reply = replyFromPayload(parsed);
  if (!reply) {
    return {
      model,
      status: "error",
      httpStatus,
      ms,
      error: errorMessageFromPayload(parsed, "") || "Empty reply"
    };
  }
  return { model, status: "ok", httpStatus, ms, reply };
}

export function modelsFromListPayload(payload: unknown): ProbeModel[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return [];
  return payload.data.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) return [];
    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : item.id;
    return [{ id: item.id, name }];
  });
}

function replyFromPayload(payload: unknown): string {
  if (!isRecord(payload)) return "";
  const choices = payload.choices;
  if (Array.isArray(choices) && isRecord(choices[0])) {
    const message = isRecord(choices[0].message) ? choices[0].message : undefined;
    if (typeof message?.content === "string" && message.content.trim()) return message.content.trim();
    if (typeof choices[0].text === "string" && choices[0].text.trim()) return choices[0].text.trim();
  }
  if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text.trim();
  return "";
}

function errorMessageFromPayload(payload: unknown, fallback: string): string {
  if (isRecord(payload)) {
    if (isRecord(payload.error) && typeof payload.error.message === "string" && payload.error.message.trim()) {
      return payload.error.message.trim();
    }
    if (typeof payload.message === "string" && payload.message.trim()) return payload.message.trim();
  }
  const trimmed = fallback.trim();
  return trimmed.length > 280 ? `${trimmed.slice(0, 277)}…` : trimmed;
}

function parseJson(body: string): unknown {
  if (!body.trim()) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
