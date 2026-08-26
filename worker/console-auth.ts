import { sha256Hex } from "./crypto";
import { getConsolePasswordHash, setConsolePasswordHash } from "./db";
import { HttpError } from "./http";
import type { Deps, Env } from "./types";

const encoder = new TextEncoder();

const COOKIE_NAME = "cursor_api_console";
const HOST_KEY_COOKIE_NAME = "cursor_api_host_key";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const HOST_KEY_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const SESSION_VERSION = "v1";
const HOST_KEY_SESSION_VERSION = "hk1";
export const MIN_CONSOLE_PASSWORD_LENGTH = 8;

const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_WINDOW_MS = 10 * 60 * 1000;

const failedLogins = new Map<string, { count: number; firstAttemptAt: number }>();

/**
 * Gate is on when D1 has a password hash, or when `CONSOLE_PASSWORD` is still
 * the bootstrap secret (copied into D1 on first successful sign-in).
 */
export async function consoleAuthEnabled(env: Env): Promise<boolean> {
  return Boolean(await resolvePasswordHash(env));
}

export async function hasConsoleSession(request: Request, env: Env, deps: Deps): Promise<boolean> {
  return verifySignedSession(request, deps, {
    cookieName: COOKIE_NAME,
    version: SESSION_VERSION,
    secret: await consoleSessionSecret(env)
  });
}

export async function requireConsoleSession(request: Request, env: Env, deps: Deps): Promise<void> {
  if (!(await consoleAuthEnabled(env))) return;
  if (await hasConsoleSession(request, env, deps)) return;
  throw new HttpError("Console sign-in required", 401, "console_unauthorized");
}

export async function verifyConsolePassword(env: Env, candidate: string): Promise<boolean> {
  const expected = await resolvePasswordHash(env);
  if (!expected) return false;
  return timingSafeEqual(encoder.encode(await sha256Hex(candidate)), encoder.encode(expected));
}

/** After a successful env-password login, persist the hash so env can be dropped. */
export async function persistConsolePasswordFromLogin(env: Env, password: string): Promise<void> {
  if (await getConsolePasswordHash(env)) return;
  await setConsolePasswordHash(env, await sha256Hex(password));
}

export async function changeConsolePassword(
  env: Env,
  input: { currentPassword: string; newPassword: string }
): Promise<void> {
  const newPassword = input.newPassword;
  if (newPassword.length < MIN_CONSOLE_PASSWORD_LENGTH) {
    throw new HttpError(
      `Password must be at least ${MIN_CONSOLE_PASSWORD_LENGTH} characters`,
      400,
      "invalid_request_error",
      "newPassword"
    );
  }
  if (await consoleAuthEnabled(env)) {
    if (!input.currentPassword) {
      throw new HttpError("Current password is required", 400, "invalid_request_error", "currentPassword");
    }
    if (!(await verifyConsolePassword(env, input.currentPassword))) {
      throw new HttpError("Incorrect current password", 403, "console_forbidden");
    }
  }
  await setConsolePasswordHash(env, await sha256Hex(newPassword));
}

export async function issueConsoleSession(
  env: Env,
  deps: Deps,
  secure: boolean
): Promise<{ cookie: string; expiresAt: number }> {
  const expiresAt = Math.floor(deps.now().getTime() / 1000) + SESSION_TTL_SECONDS;
  const payload = `${SESSION_VERSION}.${expiresAt}`;
  const signature = await signPayload(await consoleSessionSecret(env), payload);
  return {
    cookie: serializeCookie(COOKIE_NAME, `${payload}.${signature}`, secure, SESSION_TTL_SECONDS),
    expiresAt
  };
}

export function clearConsoleSessionCookie(secure: boolean): string {
  return serializeCookie(COOKIE_NAME, "", secure, 0);
}

export async function hasHostKeySession(request: Request, env: Env, deps: Deps): Promise<boolean> {
  return verifySignedSession(request, deps, {
    cookieName: HOST_KEY_COOKIE_NAME,
    version: HOST_KEY_SESSION_VERSION,
    secret: hostKeySessionSecret(env)
  });
}

export async function issueHostKeySession(
  env: Env,
  deps: Deps,
  secure: boolean
): Promise<{ cookie: string; expiresAt: number }> {
  const expiresAt = Math.floor(deps.now().getTime() / 1000) + HOST_KEY_SESSION_TTL_SECONDS;
  const payload = `${HOST_KEY_SESSION_VERSION}.${expiresAt}`;
  const signature = await signPayload(hostKeySessionSecret(env), payload);
  return {
    cookie: serializeCookie(HOST_KEY_COOKIE_NAME, `${payload}.${signature}`, secure, HOST_KEY_SESSION_TTL_SECONDS),
    expiresAt
  };
}

export function clearHostKeySessionCookie(secure: boolean): string {
  return serializeCookie(HOST_KEY_COOKIE_NAME, "", secure, 0);
}

/**
 * Throttle password guessing per client. Worker isolates are short-lived, so
 * this is a speed bump rather than a durable lockout.
 */
export function assertLoginAttemptAllowed(clientId: string, now: number): void {
  const entry = failedLogins.get(clientId);
  if (!entry) return;
  if (now - entry.firstAttemptAt > LOCKOUT_WINDOW_MS) {
    failedLogins.delete(clientId);
    return;
  }
  if (entry.count >= MAX_FAILED_ATTEMPTS) {
    throw new HttpError("Too many sign-in attempts. Try again later.", 429, "rate_limited");
  }
}

export function recordFailedLogin(clientId: string, now: number): void {
  const entry = failedLogins.get(clientId);
  if (!entry || now - entry.firstAttemptAt > LOCKOUT_WINDOW_MS) {
    failedLogins.set(clientId, { count: 1, firstAttemptAt: now });
    return;
  }
  entry.count += 1;
}

export function clearFailedLogins(clientId: string): void {
  failedLogins.delete(clientId);
}

export function loginClientId(request: Request): string {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "local";
}

function serializeCookie(name: string, value: string, secure: boolean, maxAge: number): string {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAge}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

async function verifySignedSession(
  request: Request,
  deps: Deps,
  input: { cookieName: string; version: string; secret: string }
): Promise<boolean> {
  const raw = readCookie(request, input.cookieName);
  if (!raw) return false;

  const separator = raw.lastIndexOf(".");
  if (separator <= 0) return false;
  const payload = raw.slice(0, separator);
  const signature = raw.slice(separator + 1);

  const [version, expiry] = payload.split(".");
  if (version !== input.version) return false;
  const expiresAt = Number(expiry);
  if (!Number.isFinite(expiresAt) || expiresAt * 1000 <= deps.now().getTime()) return false;

  const expected = await signPayload(input.secret, payload);
  return timingSafeEqual(encoder.encode(expected), encoder.encode(signature));
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value || undefined;
  }
  return undefined;
}

async function resolvePasswordHash(env: Env): Promise<string | null> {
  const stored = await getConsolePasswordHash(env);
  if (stored) return stored;
  const bootstrap = env.CONSOLE_PASSWORD?.trim();
  return bootstrap ? sha256Hex(bootstrap) : null;
}

/**
 * Binding the signing key to the password hash means rotating it invalidates
 * every outstanding session.
 */
async function consoleSessionSecret(env: Env): Promise<string> {
  return `console-session:${env.ENCRYPTION_KEY || ""}:${(await resolvePasswordHash(env)) || ""}`;
}

function hostKeySessionSecret(env: Env): string {
  return `host-key-session:${env.ENCRYPTION_KEY || ""}`;
}

async function signPayload(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(encoder.encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, toArrayBuffer(encoder.encode(payload)));
  return base64UrlEncode(new Uint8Array(signature));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let mismatch = 0;
  for (let index = 0; index < a.byteLength; index += 1) {
    mismatch |= a[index] ^ b[index];
  }
  return mismatch === 0;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
