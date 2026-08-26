import {
  insertAppSettingIfAbsent,
  listAppSettings,
  upsertAppSetting
} from "./app-store";
import type { Env } from "./types";

export const SETTING = {
  encryptionKey: "encryption_key",
  sdkListenHost: "sdk_listen_host",
  sdkListenPort: "sdk_listen_port",
  sdkBridgeUrl: "sdk_bridge_url",
  sdkBridgeToken: "sdk_bridge_token",
  sdkBridgeTimeoutMs: "sdk_bridge_timeout_ms",
  relayListenHost: "relay_listen_host",
  relayListenPort: "relay_listen_port",
  cursorApiBase: "cursor_api_base",
  cursorBackendBaseUrl: "cursor_backend_base_url",
  cursorChatEndpoint: "cursor_chat_endpoint",
  cursorClientVersion: "cursor_client_version",
  cursorSdkClientVersion: "cursor_sdk_client_version",
  cursorLocalAgentEndpoint: "cursor_local_agent_endpoint"
} as const;

export const APP_CONFIG_DEFAULTS = {
  sdkListenHost: "127.0.0.1",
  sdkListenPort: 8792,
  sdkBridgeTimeoutMs: 180_000,
  relayListenHost: "0.0.0.0",
  relayListenPort: 5173,
  cursorApiBase: "https://api.cursor.com",
  cursorClientVersion: "2.6.22",
  cursorSdkClientVersion: "sdk-1.0.13"
} as const;

export interface AppConfig {
  encryptionKey: string;
  encryptionKeyPresent: boolean;
  sdkListenHost: string;
  sdkListenPort: number;
  sdkBridgeUrl: string;
  sdkBridgeToken: string;
  sdkBridgeTimeoutMs: number;
  relayListenHost: string;
  relayListenPort: number;
  cursorApiBase: string;
  cursorBackendBaseUrl: string;
  cursorChatEndpoint: string;
  cursorClientVersion: string;
  cursorSdkClientVersion: string;
  cursorLocalAgentEndpoint: string;
}

export interface RuntimeSettingsPatch {
  sdkListenHost?: string;
  sdkListenPort?: number;
  relayListenHost?: string;
  relayListenPort?: number;
}

/** Load D1 settings, generating ENCRYPTION_KEY once and importing leftover env values. */
export async function ensureAppConfig(env: Env): Promise<AppConfig> {
  const stored = await listAppSettings(env);
  if (!stored.get(SETTING.encryptionKey)?.trim()) {
    const imported = env.ENCRYPTION_KEY?.trim() ?? "";
    const key = imported.length >= 16 ? imported : randomEncryptionKeyHex();
    await insertAppSettingIfAbsent(env, SETTING.encryptionKey, key);
  }

  const sdkFromEnv = parseBridgeListen(env.CURSOR_SDK_BRIDGE_URL);
  const sdkHost = stored.get(SETTING.sdkListenHost)?.trim() || sdkFromEnv?.host || APP_CONFIG_DEFAULTS.sdkListenHost;
  const sdkPort =
    parsePort(stored.get(SETTING.sdkListenPort)) ?? sdkFromEnv?.port ?? APP_CONFIG_DEFAULTS.sdkListenPort;
  const sdkUrl = stored.get(SETTING.sdkBridgeUrl)?.trim() || env.CURSOR_SDK_BRIDGE_URL?.trim() || "";

  const bootstraps: Array<[string, string | undefined]> = [
    [SETTING.sdkListenHost, stored.get(SETTING.sdkListenHost) ? undefined : sdkHost],
    [SETTING.sdkListenPort, stored.get(SETTING.sdkListenPort) ? undefined : String(sdkPort)],
    [
      SETTING.sdkBridgeUrl,
      stored.has(SETTING.sdkBridgeUrl) ? undefined : sdkUrl
    ],
    [
      SETTING.sdkBridgeToken,
      stored.has(SETTING.sdkBridgeToken) ? undefined : env.CURSOR_SDK_BRIDGE_TOKEN?.trim() || ""
    ],
    [
      SETTING.sdkBridgeTimeoutMs,
      stored.get(SETTING.sdkBridgeTimeoutMs)
        ? undefined
        : env.CURSOR_SDK_BRIDGE_TIMEOUT_MS?.trim() || String(APP_CONFIG_DEFAULTS.sdkBridgeTimeoutMs)
    ],
    [
      SETTING.relayListenHost,
      stored.get(SETTING.relayListenHost) ? undefined : APP_CONFIG_DEFAULTS.relayListenHost
    ],
    [
      SETTING.relayListenPort,
      stored.get(SETTING.relayListenPort) ? undefined : String(APP_CONFIG_DEFAULTS.relayListenPort)
    ],
    [
      SETTING.cursorApiBase,
      stored.get(SETTING.cursorApiBase)
        ? undefined
        : env.CURSOR_API_BASE?.trim() || APP_CONFIG_DEFAULTS.cursorApiBase
    ],
    [
      SETTING.cursorBackendBaseUrl,
      stored.has(SETTING.cursorBackendBaseUrl) ? undefined : env.CURSOR_BACKEND_BASE_URL?.trim() || ""
    ],
    [
      SETTING.cursorChatEndpoint,
      stored.has(SETTING.cursorChatEndpoint) ? undefined : env.CURSOR_CHAT_ENDPOINT?.trim() || ""
    ],
    [
      SETTING.cursorClientVersion,
      stored.get(SETTING.cursorClientVersion)
        ? undefined
        : env.CURSOR_CLIENT_VERSION?.trim() || APP_CONFIG_DEFAULTS.cursorClientVersion
    ],
    [
      SETTING.cursorSdkClientVersion,
      stored.get(SETTING.cursorSdkClientVersion)
        ? undefined
        : env.CURSOR_SDK_CLIENT_VERSION?.trim() || APP_CONFIG_DEFAULTS.cursorSdkClientVersion
    ],
    [
      SETTING.cursorLocalAgentEndpoint,
      stored.has(SETTING.cursorLocalAgentEndpoint) ? undefined : env.CURSOR_LOCAL_AGENT_ENDPOINT?.trim() || ""
    ]
  ];

  for (const [key, value] of bootstraps) {
    if (value === undefined) continue;
    await insertAppSettingIfAbsent(env, key, value);
  }

  return readAppConfig(await listAppSettings(env));
}

export function overlayEnv(env: Env, config: AppConfig): Env {
  return {
    ...env,
    ENCRYPTION_KEY: config.encryptionKey,
    CURSOR_SDK_BRIDGE_URL: overlaySdkBridgeUrl(config, env.CURSOR_SDK_BRIDGE_URL),
    CURSOR_SDK_BRIDGE_TOKEN: config.sdkBridgeToken || undefined,
    CURSOR_SDK_BRIDGE_TIMEOUT_MS: String(config.sdkBridgeTimeoutMs),
    CURSOR_API_BASE: config.cursorApiBase || undefined,
    CURSOR_BACKEND_BASE_URL: config.cursorBackendBaseUrl || undefined,
    CURSOR_CHAT_ENDPOINT: config.cursorChatEndpoint || undefined,
    CURSOR_CLIENT_VERSION: config.cursorClientVersion || undefined,
    CURSOR_SDK_CLIENT_VERSION: config.cursorSdkClientVersion || undefined,
    CURSOR_LOCAL_AGENT_ENDPOINT: config.cursorLocalAgentEndpoint || undefined
  };
}

export async function updateRuntimeSettings(env: Env, patch: RuntimeSettingsPatch): Promise<AppConfig> {
  if (patch.sdkListenHost !== undefined) {
    await upsertAppSetting(env, SETTING.sdkListenHost, patch.sdkListenHost);
  }
  if (patch.sdkListenPort !== undefined) {
    await upsertAppSetting(env, SETTING.sdkListenPort, String(patch.sdkListenPort));
  }
  if (patch.relayListenHost !== undefined) {
    await upsertAppSetting(env, SETTING.relayListenHost, patch.relayListenHost);
  }
  if (patch.relayListenPort !== undefined) {
    await upsertAppSetting(env, SETTING.relayListenPort, String(patch.relayListenPort));
  }

  const next = await ensureAppConfig(env);
  if (patch.sdkListenHost !== undefined || patch.sdkListenPort !== undefined) {
    await upsertAppSetting(env, SETTING.sdkBridgeUrl, workerReachableSdkBridgeUrl(next));
  }
  return readAppConfig(await listAppSettings(env));
}

export function parseListenHost(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Host is required");
  }
  const host = value.trim();
  if (/\s/.test(host) || host.includes("/") || host.includes(":")) {
    throw new Error("Host must be a hostname or IP without a port");
  }
  return host;
}

export function parseListenPort(value: unknown): number {
  const port = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Port must be an integer between 1 and 65535");
  }
  return port;
}

export function sdkControlOrigin(config: AppConfig): string {
  const stored = config.sdkBridgeUrl.trim();
  if (stored) {
    try {
      return new URL(stored).origin;
    } catch {
      /* fall through */
    }
  }
  return `http://${config.sdkListenHost}:${config.sdkListenPort}`;
}

/** Worker-to-bridge URL. Rewrites 0.0.0.0 so workerd can reach the local Node bridge. */
export function workerReachableSdkBridgeUrl(config: AppConfig): string {
  const host =
    config.sdkListenHost === "0.0.0.0" || config.sdkListenHost === "::" || config.sdkListenHost === "[::]"
      ? "127.0.0.1"
      : config.sdkListenHost;
  return `http://${host}:${config.sdkListenPort}/sdk`;
}

function overlaySdkBridgeUrl(config: AppConfig, envUrl: string | undefined): string | undefined {
  const configured = config.sdkBridgeUrl.trim() || envUrl?.trim() || "";
  if (!configured) return undefined;
  if (isLoopbackSdkBridgeUrl(configured)) return workerReachableSdkBridgeUrl(config);
  return configured;
}

function isLoopbackSdkBridgeUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host === "::";
  } catch {
    return false;
  }
}

function readAppConfig(stored: Map<string, string>): AppConfig {
  const sdkHost = stored.get(SETTING.sdkListenHost)?.trim() || APP_CONFIG_DEFAULTS.sdkListenHost;
  const sdkPort = parsePort(stored.get(SETTING.sdkListenPort)) ?? APP_CONFIG_DEFAULTS.sdkListenPort;
  const encryptionKey = stored.get(SETTING.encryptionKey)?.trim() || "";
  return {
    encryptionKey,
    encryptionKeyPresent: encryptionKey.length > 0,
    sdkListenHost: sdkHost,
    sdkListenPort: sdkPort,
    sdkBridgeUrl: stored.get(SETTING.sdkBridgeUrl)?.trim() || "",
    sdkBridgeToken: stored.get(SETTING.sdkBridgeToken) || "",
    sdkBridgeTimeoutMs:
      parsePositiveInt(stored.get(SETTING.sdkBridgeTimeoutMs)) ?? APP_CONFIG_DEFAULTS.sdkBridgeTimeoutMs,
    relayListenHost: stored.get(SETTING.relayListenHost)?.trim() || APP_CONFIG_DEFAULTS.relayListenHost,
    relayListenPort: parsePort(stored.get(SETTING.relayListenPort)) ?? APP_CONFIG_DEFAULTS.relayListenPort,
    cursorApiBase: stored.get(SETTING.cursorApiBase)?.trim() || APP_CONFIG_DEFAULTS.cursorApiBase,
    cursorBackendBaseUrl: stored.get(SETTING.cursorBackendBaseUrl)?.trim() || "",
    cursorChatEndpoint: stored.get(SETTING.cursorChatEndpoint)?.trim() || "",
    cursorClientVersion: stored.get(SETTING.cursorClientVersion)?.trim() || APP_CONFIG_DEFAULTS.cursorClientVersion,
    cursorSdkClientVersion:
      stored.get(SETTING.cursorSdkClientVersion)?.trim() || APP_CONFIG_DEFAULTS.cursorSdkClientVersion,
    cursorLocalAgentEndpoint: stored.get(SETTING.cursorLocalAgentEndpoint)?.trim() || ""
  };
}

function parseBridgeListen(url: string | undefined): { host: string; port: number } | null {
  const raw = url?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const port = parsed.port
      ? Number(parsed.port)
      : parsed.protocol === "https:"
        ? 443
        : 80;
    if (!parsed.hostname || !Number.isInteger(port)) return null;
    return { host: parsed.hostname, port };
  } catch {
    return null;
  }
}

function parsePort(value: string | undefined): number | null {
  if (!value) return null;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function randomEncryptionKeyHex(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
