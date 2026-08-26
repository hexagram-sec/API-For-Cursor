import {
  APP_CONFIG_DEFAULTS,
  ensureAppConfig,
  overlayEnv,
  parseListenHost,
  parseListenPort,
  sdkControlOrigin,
  updateRuntimeSettings,
  type AppConfig
} from "./app-config";
import { insertAccessLog, listAccessLogs } from "./app-store";
import { collectCursorOutput, createCursorCompletion, listCursorModels, resolveCursorModel, streamCursorText, verifyCursorApiKey } from "./cursor";
import { collectCursorSdkOutput, createCursorSdkCompletion } from "./cursor-sdk";
import {
  assertLoginAttemptAllowed,
  changeConsolePassword,
  clearConsoleSessionCookie,
  clearFailedLogins,
  consoleAuthEnabled,
  hasConsoleSession,
  issueConsoleSession,
  loginClientId,
  persistConsolePasswordFromLogin,
  recordFailedLogin,
  requireConsoleSession,
  verifyConsolePassword
} from "./console-auth";
import {
  createRelayKey,
  deleteCursorKey,
  deleteRelayKey,
  getCursorKey,
  getCursorKeyRecord,
  listCursorKeys,
  listRelayKeys,
  resolveRelayKey,
  setDefaultCursorKey,
  updateCursorKeyValue,
  updateRelayKey,
  upsertCursorKey
} from "./db";
import { bearerToken, errorResponse, HttpError, json, notFound, openAiError, optionsResponse, parseJsonBody, sseResponse, unauthorized, withCors } from "./http";
import {
  chatChunk,
  chatCompletionResponse,
  chatUsageChunk,
  completionCharsFromOutput,
  doneChunk,
  modelList,
  modelListFromCursor,
  prepareChatRequest,
  prepareOpencodeSdkChatRequest,
  prepareResponsesRequest,
  responseCreatedEvents,
  responseDeltaEvent,
  responseDoneEvents,
  responseInputItemsObject,
  responseObject,
  responseTextStartEvents,
  responseToolCallEvents,
  toolCallRetryHint,
  toOpenAiToolCalls
} from "./openai";
import { encodeSse } from "./sse";
import type { Deps, Env } from "./types";
import type { CursorTextEvent } from "./cursor";
import type { ToolCallContext } from "./openai";
import type { OpenAiToolSpec } from "./openai";

/** Per-request fields filled while handling `/v1` or `/api/admin`. */
interface AccessLogDraft {
  relayKeyId?: string | null;
  cursorKeyId?: string | null;
  model?: string | null;
  error?: string | null;
}

let listenersSynced = false;

/**
 * The only way a `/v1/...` request can be authenticated: an `sk-...` relay key
 * resolved against D1 to its backing Cursor token. Requests without a relay key
 * (no bearer, or a raw Cursor key) are rejected and never forwarded to Cursor.
 */
type AuthResult = { mode: "relay"; cursorKeyId: string; relayKeyId: string; cursorApiKey: string };

/** Shape passed to the (now no-op) completion logger; kept for callback typing. */
type FinishLogInput = { status: string; completionChars?: number; cursorAgentId?: string; cursorRunId?: string; error?: string };

interface StoredResponseState {
  ownerKey: string;
  id: string;
  response?: Record<string, unknown>;
  inputItems: unknown[];
  outputItems: unknown[];
  sdkSessionKey?: string;
  updatedAt: number;
}

const responseState = new Map<string, StoredResponseState>();
const RESPONSE_STATE_LIMIT = 512;

const defaultDeps: Deps = {
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
  randomUUID: () => crypto.randomUUID()
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx, defaultDeps);
  }
};

export async function handleRequest(request: Request, env: Env, ctx: ExecutionContext, deps: Deps = defaultDeps): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return optionsResponse();

  const config = await ensureAppConfig(env);
  env = overlayEnv(env, config);
  ctx.waitUntil(syncListenersOnce(deps, url, config));

  try {
    if (url.pathname === "/api/console/session" && request.method === "GET") {
      return await handleConsoleSession(request, env, deps);
    }
    if (url.pathname === "/api/console/login" && request.method === "POST") {
      return await handleConsoleLogin(request, env, deps, url);
    }
    if (url.pathname === "/api/console/logout" && request.method === "POST") {
      return await handleConsoleLogout(env, url);
    }
    if (url.pathname.startsWith("/api/admin/")) {
      return await withAccessLog(env, ctx, request, url, async () => {
        await requireConsoleSession(request, env, deps);
        return await handleAdminRoute(request, env, deps, url);
      });
    }
    const route = matchOpenAiRoute(url.pathname);
    if (route) {
      return await withAccessLog(env, ctx, request, url, (log) => handleOpenAiRoute(request, env, ctx, deps, route, log));
    }

    const staleAssetFallback = staleViteAssetFallbackPath(url.pathname);
    if (staleAssetFallback) {
      const response = await fetchAsset(env, request, staleAssetFallback);
      if (response.status !== 404) return withCors(response);
    }

    // Client-side routes (e.g. `/chat`) have no matching asset; serve the SPA
    // shell so the front-end router can take over.
    if (isDocumentRequest(request, url) && url.pathname !== "/") {
      const indexRequest = new Request(new URL("/", url).toString(), {
        method: "GET",
        headers: request.headers
      });
      return withCors(await env.ASSETS.fetch(indexRequest));
    }
    return withCors(await env.ASSETS.fetch(request));
  } catch (error) {
    return errorResponse(error);
  }
}

function staleViteAssetFallbackPath(pathname: string): string | null {
  if (/^\/assets\/index-[A-Za-z0-9_-]+\.css$/.test(pathname)) return "/assets/index.css";
  if (/^\/assets\/index-[A-Za-z0-9_-]+\.js$/.test(pathname)) return "/assets/index.js";
  if (/^\/assets\/index-[A-Za-z0-9_-]+\.js\.map$/.test(pathname)) return "/assets/index.js.map";
  if (/^\/assets\/chat-[A-Za-z0-9_-]+\.js$/.test(pathname)) return "/assets/chat.js";
  if (/^\/assets\/chat-[A-Za-z0-9_-]+\.js\.map$/.test(pathname)) return "/assets/chat.js.map";
  return null;
}

function fetchAsset(env: Env, request: Request, pathname: string): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = "";
  return env.ASSETS.fetch(
    new Request(url.toString(), {
      method: "GET",
      headers: request.headers
    })
  );
}

async function handleConsoleSession(request: Request, env: Env, deps: Deps): Promise<Response> {
  const authRequired = await consoleAuthEnabled(env);
  return json({
    authRequired,
    authenticated: authRequired ? await hasConsoleSession(request, env, deps) : true
  });
}

async function handleConsoleLogin(request: Request, env: Env, deps: Deps, url: URL): Promise<Response> {
  if (!(await consoleAuthEnabled(env))) {
    throw new HttpError("Console password is not configured", 409, "console_auth_disabled");
  }

  const body = await parseJsonBody<Record<string, unknown>>(request);
  const password = typeof body.password === "string" ? body.password : "";
  if (!password) throw new HttpError("Password is required", 400, "invalid_request_error", "password");

  const clientId = loginClientId(request);
  const now = deps.now().getTime();
  assertLoginAttemptAllowed(clientId, now);

  if (!(await verifyConsolePassword(env, password))) {
    recordFailedLogin(clientId, now);
    throw new HttpError("Incorrect password", 401, "console_unauthorized");
  }

  clearFailedLogins(clientId);
  await persistConsolePasswordFromLogin(env, password);
  const session = await issueConsoleSession(env, deps, url.protocol === "https:");
  return json(
    { authRequired: true, authenticated: true, expiresAt: session.expiresAt },
    { headers: { "set-cookie": session.cookie } }
  );
}

async function handleConsoleLogout(env: Env, url: URL): Promise<Response> {
  return json(
    { authRequired: await consoleAuthEnabled(env), authenticated: false },
    { headers: { "set-cookie": clearConsoleSessionCookie(url.protocol === "https:") } }
  );
}

/* ---------- Admin backend (all behind requireConsoleSession) ---------- */

async function handleAdminRoute(request: Request, env: Env, deps: Deps, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/admin/password") {
    if (method !== "PUT") return notFound();
    return await handleAdminChangePassword(request, env, deps, url);
  }

  if (path === "/api/admin/runtime") {
    if (method !== "GET") return notFound();
    return await handleAdminRuntime(request, env, deps, url);
  }

  if (path === "/api/admin/settings") {
    if (method !== "PUT") return notFound();
    return await handleAdminSettings(request, env, deps, url);
  }

  if (path === "/api/admin/access-logs") {
    if (method !== "GET") return notFound();
    return await handleAdminAccessLogs(env, url);
  }

  if (path === "/api/admin/cursor-keys") {
    if (method === "GET") return json({ keys: await listCursorKeys(env) });
    if (method === "POST") return await handleAdminCreateCursorKey(request, env, deps);
    return notFound();
  }
  const cursorKeyMatch = /^\/api\/admin\/cursor-keys\/([^/]+?)(\/test)?$/.exec(path);
  if (cursorKeyMatch) {
    const id = decodeURIComponent(cursorKeyMatch[1]);
    if (cursorKeyMatch[2]) {
      if (method !== "POST") return notFound();
      return await handleAdminTestCursorKey(env, deps, id);
    }
    if (method === "GET") return await handleAdminGetCursorKey(env, id);
    if (method === "PUT") return await handleAdminUpdateCursorKey(request, env, deps, id);
    if (method === "DELETE") {
      await deleteCursorKey(env, id);
      return json({ ok: true });
    }
    return notFound();
  }

  if (path === "/api/admin/relay-keys") {
    if (method === "GET") return json({ keys: await listRelayKeys(env), baseUrl: `${url.origin}/v1` });
    if (method === "POST") return await handleAdminCreateRelayKey(request, env);
    return notFound();
  }
  const relayKeyMatch = /^\/api\/admin\/relay-keys\/([^/]+?)(\/test)?$/.exec(path);
  if (relayKeyMatch) {
    const id = decodeURIComponent(relayKeyMatch[1]);
    if (relayKeyMatch[2]) {
      if (method !== "POST") return notFound();
      return await handleAdminTestRelayKey(env, deps, id);
    }
    if (method === "PUT") return await handleAdminUpdateRelayKey(request, env, id);
    if (method === "DELETE") {
      await deleteRelayKey(env, id);
      return json({ ok: true });
    }
    return notFound();
  }

  return notFound();
}

async function handleAdminRuntime(_request: Request, env: Env, deps: Deps, url: URL): Promise<Response> {
  const config = await ensureAppConfig(env);
  const probe = await probeSdkBridge(deps, config);
  return json({
    encryptionKey: { present: config.encryptionKeyPresent },
    sdk: {
      host: config.sdkListenHost,
      port: config.sdkListenPort,
      url: config.sdkBridgeUrl || `${sdkControlOrigin(config)}/sdk`,
      probe
    },
    relay: {
      host: config.relayListenHost,
      port: config.relayListenPort,
      currentOrigin: url.origin
    }
  });
}

async function handleAdminSettings(request: Request, env: Env, deps: Deps, url: URL): Promise<Response> {
  const body = await parseJsonBody<Record<string, unknown>>(request);
  const current = await ensureAppConfig(env);
  const patch: {
    sdkListenHost?: string;
    sdkListenPort?: number;
    relayListenHost?: string;
    relayListenPort?: number;
  } = {};

  if (body.sdkListenHost !== undefined) patch.sdkListenHost = listenHostField(body.sdkListenHost, "sdkListenHost");
  if (body.sdkListenPort !== undefined) patch.sdkListenPort = listenPortField(body.sdkListenPort, "sdkListenPort");
  if (body.relayListenHost !== undefined) patch.relayListenHost = listenHostField(body.relayListenHost, "relayListenHost");
  if (body.relayListenPort !== undefined) patch.relayListenPort = listenPortField(body.relayListenPort, "relayListenPort");

  const next = await updateRuntimeSettings(env, patch);
  const sdkChanged = patch.sdkListenHost !== undefined || patch.sdkListenPort !== undefined;
  const relayChanged = patch.relayListenHost !== undefined || patch.relayListenPort !== undefined;

  let sdkRebind: { ok: boolean; error?: string } = { ok: true };
  if (sdkChanged) {
    sdkRebind = await postSdkListen(deps, current, {
      host: next.sdkListenHost,
      port: next.sdkListenPort
    });
  }

  let relayRebind: { ok: boolean; newOrigin?: string; appliedOnNextStart: boolean; error?: string } = {
    ok: true,
    appliedOnNextStart: false
  };
  if (relayChanged) {
    relayRebind = await postRelayRebind(deps, url.origin, {
      host: next.relayListenHost,
      port: next.relayListenPort
    });
  }

  return json({
    ok: true,
    encryptionKey: { present: next.encryptionKeyPresent },
    sdk: {
      host: next.sdkListenHost,
      port: next.sdkListenPort,
      url: next.sdkBridgeUrl || `${sdkControlOrigin(next)}/sdk`,
      rebind: sdkRebind
    },
    relay: {
      host: next.relayListenHost,
      port: next.relayListenPort,
      currentOrigin: url.origin,
      rebind: relayRebind
    }
  });
}

async function handleAdminAccessLogs(env: Env, url: URL): Promise<Response> {
  const limit = Number(url.searchParams.get("limit") || "50");
  const offset = Number(url.searchParams.get("offset") || "0");
  const query = url.searchParams.get("q") || "";
  const { logs, total } = await listAccessLogs(
    env,
    Number.isFinite(limit) ? limit : 50,
    Number.isFinite(offset) ? offset : 0,
    query
  );
  return json({
    logs: logs.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      method: row.method,
      path: row.path,
      status: row.status,
      durationMs: row.duration_ms,
      clientIp: row.client_ip,
      relayKeyId: row.relay_key_id,
      cursorKeyId: row.cursor_key_id,
      model: row.model,
      error: row.error
    })),
    total,
    query,
    limit: Math.min(Math.max(1, Number.isFinite(limit) ? limit : 50), 200),
    offset: Math.max(0, Number.isFinite(offset) ? offset : 0)
  });
}

async function handleAdminChangePassword(request: Request, env: Env, deps: Deps, url: URL): Promise<Response> {
  const body = await parseJsonBody<Record<string, unknown>>(request);
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  if (!newPassword) throw new HttpError("New password is required", 400, "invalid_request_error", "newPassword");
  await changeConsolePassword(env, { currentPassword, newPassword });
  const session = await issueConsoleSession(env, deps, url.protocol === "https:");
  return json(
    { ok: true, authRequired: true, authenticated: true, expiresAt: session.expiresAt },
    { headers: { "set-cookie": session.cookie } }
  );
}

async function handleAdminGetCursorKey(env: Env, id: string): Promise<Response> {
  const record = await getCursorKey(env, id);
  if (!record) throw new HttpError("Cursor key not found", 404, "not_found");
  const { cursorApiKey, ...meta } = record;
  return json({ key: { ...meta, key: cursorApiKey } });
}

async function handleAdminCreateCursorKey(request: Request, env: Env, deps: Deps): Promise<Response> {
  const body = await parseJsonBody<Record<string, unknown>>(request);
  const cursorApiKey = typeof body.cursorApiKey === "string" ? body.cursorApiKey.trim() : "";
  if (!cursorApiKey) throw new HttpError("Cursor API key is required", 400, "invalid_request_error", "cursorApiKey");
  const me = await verifyCursorApiKey(env, deps, cursorApiKey);
  const record = await upsertCursorKey(env, cursorApiKey, me, { makeDefault: body.makeDefault === true });
  return json({ key: record });
}

async function handleAdminUpdateCursorKey(request: Request, env: Env, deps: Deps, id: string): Promise<Response> {
  const existing = await getCursorKeyRecord(env, id);
  if (!existing) throw new HttpError("Cursor key not found", 404, "not_found");
  const body = await parseJsonBody<Record<string, unknown>>(request);

  const cursorApiKey = typeof body.cursorApiKey === "string" ? body.cursorApiKey.trim() : "";
  if (cursorApiKey) {
    const me = await verifyCursorApiKey(env, deps, cursorApiKey);
    await updateCursorKeyValue(env, id, cursorApiKey, me);
  }
  if (body.makeDefault === true) await setDefaultCursorKey(env, id);

  return json({ key: await getCursorKeyRecord(env, id) });
}

async function handleAdminTestCursorKey(env: Env, deps: Deps, id: string): Promise<Response> {
  const record = await getCursorKey(env, id);
  if (!record) throw new HttpError("Cursor key not found", 404, "not_found");
  return json(await testCursorApiKey(env, deps, record.cursorApiKey));
}

async function testCursorApiKey(env: Env, deps: Deps, cursorApiKey: string): Promise<Record<string, unknown>> {
  const me = await verifyCursorApiKey(env, deps, cursorApiKey);
  let modelCount: number | null = null;
  try {
    const models = await listCursorModels(env, deps, cursorApiKey);
    modelCount = models.items?.length ?? 0;
  } catch {
    modelCount = null;
  }
  return {
    ok: true,
    keyName: me.apiKeyName,
    email: me.userEmail ?? null,
    name: [me.userFirstName, me.userLastName].filter(Boolean).join(" ") || null,
    modelCount
  };
}

async function handleAdminCreateRelayKey(request: Request, env: Env): Promise<Response> {
  const body = await parseJsonBody<Record<string, unknown>>(request);
  const cursorKeyId = typeof body.cursorKeyId === "string" ? body.cursorKeyId.trim() : "";
  const name = typeof body.name === "string" ? body.name : "";
  if (!cursorKeyId) throw new HttpError("cursorKeyId is required", 400, "invalid_request_error", "cursorKeyId");
  const owner = await getCursorKeyRecord(env, cursorKeyId);
  if (!owner) throw new HttpError("Cursor key not found", 404, "not_found");
  const key = await createRelayKey(env, cursorKeyId, name);
  return json({ key });
}

async function handleAdminUpdateRelayKey(request: Request, env: Env, id: string): Promise<Response> {
  const body = await parseJsonBody<Record<string, unknown>>(request);
  const key = await updateRelayKey(env, id, {
    name: typeof body.name === "string" ? body.name : undefined,
    enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    regenerate: body.regenerate === true
  });
  if (!key) throw new HttpError("Relay key not found", 404, "not_found");
  return json({ key });
}

async function handleAdminTestRelayKey(env: Env, deps: Deps, id: string): Promise<Response> {
  const relays = await listRelayKeys(env);
  const relay = relays.find((entry) => entry.id === id);
  if (!relay) throw new HttpError("Relay key not found", 404, "not_found");
  const record = await getCursorKey(env, relay.cursorKeyId);
  if (!record) throw new HttpError("Backing Cursor key is missing", 404, "not_found");
  const result = await testCursorApiKey(env, deps, record.cursorApiKey);
  return json({ ...result, enabled: relay.enabled });
}

async function handleOpenAiRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  deps: Deps,
  route: OpenAiRoute,
  log: AccessLogDraft = {}
): Promise<Response> {
  if (route.kind === "models") {
    const auth = await authenticate(request, env, deps);
    rememberAuth(log, auth);
    if (!auth) return unauthorized();
    if (request.method !== "GET") return notFound();
    try {
      const cursor = await listCursorModels(env, deps, auth.cursorApiKey);
      return json(
        modelListFromCursor(cursor.items, {
          opencode: route.surface === "opencode" || route.surface === "opencodev2",
          sdk: route.surface === "opencodev2"
        })
      );
    } catch (error) {
      if (error instanceof HttpError && (error.status === 401 || error.status === 403)) throw error;
      return json(
        modelList({
          opencode: route.surface === "opencode" || route.surface === "opencodev2",
          sdk: route.surface === "opencodev2"
        })
      );
    }
  }

  if (route.kind === "response" || route.kind === "responseInputItems" || route.kind === "responseCancel") {
    const auth = await authenticate(request, env, deps);
    rememberAuth(log, auth);
    if (!auth) return unauthorized();
    return handleResponseStateRoute(request, auth, route);
  }

  if (route.kind !== "chat" && route.kind !== "responses") return notFound();

  if (request.method !== "POST") return notFound();
  const auth = await authenticate(request, env, deps);
  rememberAuth(log, auth);
  if (!auth) return unauthorized();

  const body = await parseJsonBody<unknown>(request);
  const requestedModel = typeof (body as { model?: unknown })?.model === "string" ? (body as { model: string }).model : "composer-2.5";
  log.model = requestedModel;
  const cursorModel = resolveCursorModel(requestedModel);
  if (route.surface === "opencodev2" && route.kind === "chat") {
    return handleOpenCodeSdkChatRoute(request, env, ctx, deps, auth, body, cursorModel);
  }

  const responseOwner = route.kind === "responses" ? await responseOwnerKey(auth) : undefined;
  const previousResponseId = route.kind === "responses" ? previousResponseIdFromBody(body) : undefined;
  const previousState = previousResponseId && responseOwner ? getResponseState(responseOwner, previousResponseId) : undefined;
  if (previousResponseId && !previousState) throw new HttpError("Response not found", 404, "not_found");
  const prepared =
    route.kind === "chat"
      ? prepareChatRequest(body, cursorModel, { forceAgentMode: route.surface === "opencode" })
      : prepareResponsesRequest(body, cursorModel, {
          previousOutput: previousState?.outputItems,
          previousInputItems: previousState?.inputItems
        });
  const id = `${route.kind === "chat" ? "chatcmpl" : "resp"}_${crypto.randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(deps.now().getTime() / 1000);
  const sdkSessionKey = route.kind === "responses"
    ? previousState?.sdkSessionKey || sessionAffinity(request) || id
    : sessionAffinity(request);
  const completionRoute: CompletionRoute =
    route.kind === "chat" ? { ...route, kind: "chat" } : { ...route, kind: "responses" };

  // Request logging was tied to the removed account model; completions run
  // without persisting per-request rows now.
  const finishLog = (_input: FinishLogInput): Promise<void> => Promise.resolve();

  try {
    if (shouldUseSdkForPreparedRoute(env, completionRoute)) {
      return await handleSdkPreparedOpenAiRoute({
        route: completionRoute,
        prepared,
        request,
        env,
        ctx,
        deps,
        auth,
        id,
        created,
        responseOwner,
        sdkSessionKey,
        finishLog
      });
    }

    const completion = await createCursorCompletion(env, deps, auth.cursorApiKey, {
      prompt: prepared.prompt,
      model: prepared.cursorModel,
      conversationKey: route.surface === "opencode" ? sessionAffinity(request) : undefined
    });

    if (prepared.stream) {
      return streamOpenAiResponse(route.kind, completion.stream, {
        id,
        created,
        model: prepared.model,
        promptChars: prepared.promptChars,
        includeUsage: prepared.includeUsage,
        metadata: prepared.responseMetadata,
        tools: prepared.tools,
        context: prepared.toolContext,
        onDone: async (text, completionChars, toolCalls) => {
          if (route.kind === "responses" && responseOwner) {
            const completed = responseObject({
              id,
              created,
              model: prepared.model,
              text,
              toolCalls,
              promptChars: prepared.promptChars,
              metadata: prepared.responseMetadata
            });
            storeResponseState(responseOwner, {
              id,
              response: completed,
              inputItems: prepared.responseInputItems ?? [],
              outputItems: (completed.output as unknown[]) ?? [],
              store: prepared.storeResponse !== false,
              sdkSessionKey,
              now: deps.now().getTime()
            });
          }
          return finishLog({
            status: "completed",
            completionChars
          });
        },
        onError: (error) =>
          finishLog({
            status: "error",
            error: error instanceof Error ? error.message : String(error)
          })
      }, ctx);
    }

    const output = await collectCursorOutput(completion.stream);
    const toolCalls = toOpenAiToolCalls({
      toolCalls: output.toolCalls,
      tools: prepared.tools,
      responseId: id,
      context: prepared.toolContext
    });
    const completionChars = completionCharsFromOutput(output.text, toolCalls);
    await finishLog({
      status: "completed",
      completionChars
    });
    if (route.kind === "chat") {
      return json(
        chatCompletionResponse({
          id,
          created,
          model: prepared.model,
          text: output.text,
          toolCalls,
          promptChars: prepared.promptChars,
          metadata: prepared.responseMetadata
        })
      );
    }
    const response = responseObject({
        id,
        created,
        model: prepared.model,
        text: output.text,
        toolCalls,
        promptChars: prepared.promptChars,
        metadata: prepared.responseMetadata
      });
    if (responseOwner) {
      storeResponseState(responseOwner, {
        id,
        response,
        inputItems: prepared.responseInputItems ?? [],
        outputItems: (response.output as unknown[]) ?? [],
        store: prepared.storeResponse !== false,
        sdkSessionKey,
        now: deps.now().getTime()
      });
    }
    return json(response);
  } catch (error) {
    await finishLog({
      status: "error",
      error: error instanceof Error ? error.message : String(error)
    }).catch(() => undefined);
    throw error;
  }
}

async function handleSdkPreparedOpenAiRoute(input: {
  route: CompletionRoute;
  prepared: ReturnType<typeof prepareChatRequest> | ReturnType<typeof prepareResponsesRequest>;
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  deps: Deps;
  auth: AuthResult;
  id: string;
  created: number;
  responseOwner?: string;
  sdkSessionKey?: string;
  finishLog: (input: FinishLogInput) => Promise<void>;
}): Promise<Response> {
  const completion = await createCursorSdkCompletion(input.env, input.deps, input.auth.cursorApiKey, {
    prompt: input.prepared.prompt,
    model: input.prepared.cursorModel,
    sessionKey: input.sdkSessionKey || sessionAffinity(input.request),
    sessionOwnerKey: sdkSessionOwner(input.auth),
    workingDirectory: input.prepared.toolContext?.workingDirectory,
    clientTools: input.prepared.tools,
    requiresLocalTool: input.prepared.requiresLocalTool,
    allowToolCall: (toolCall) => {
      if (!input.prepared.tools.length) return "No client tool inventory was available for this request.";
      const toolCalls = toOpenAiToolCalls({
        toolCalls: [toolCall],
        tools: input.prepared.tools,
        responseId: "probe",
        context: input.prepared.toolContext
      });
      return toolCalls.length > 0
        || toolCallRetryHint({ toolCall, tools: input.prepared.tools, context: input.prepared.toolContext });
    }
  });

  if (input.prepared.stream) {
    return streamOpenAiEvents(input.route.kind, completion.stream, {
      id: input.id,
      created: input.created,
      model: input.prepared.model,
      promptChars: input.prepared.promptChars,
      includeUsage: input.prepared.includeUsage,
      metadata: input.prepared.responseMetadata,
      tools: input.prepared.tools,
      context: input.prepared.toolContext,
      onDone: async (text, completionChars, toolCalls) => {
        if (input.route.kind === "responses" && input.responseOwner) {
          const completed = responseObject({
            id: input.id,
            created: input.created,
            model: input.prepared.model,
            text,
            toolCalls,
            promptChars: input.prepared.promptChars,
            metadata: input.prepared.responseMetadata
          });
          storeResponseState(input.responseOwner, {
            id: input.id,
            response: completed,
            inputItems: input.prepared.responseInputItems ?? [],
            outputItems: (completed.output as unknown[]) ?? [],
            store: input.prepared.storeResponse !== false,
            sdkSessionKey: input.sdkSessionKey,
            now: input.deps.now().getTime()
          });
        }
        return input.finishLog({
          status: "completed",
          completionChars,
          cursorAgentId: completion.agentId,
          cursorRunId: completion.runId
        });
      },
      onError: (error) =>
        input.finishLog({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
          cursorAgentId: completion.agentId,
          cursorRunId: completion.runId
        })
    }, input.ctx);
  }

  const output = await collectCursorSdkOutput(completion.stream);
  const toolCalls = toOpenAiToolCalls({
    toolCalls: output.toolCalls,
    tools: input.prepared.tools,
    responseId: input.id,
    context: input.prepared.toolContext
  });
  const completionChars = completionCharsFromOutput(output.text, toolCalls);
  await input.finishLog({
    status: "completed",
    completionChars,
    cursorAgentId: completion.agentId,
    cursorRunId: completion.runId
  });

  if (input.route.kind === "chat") {
    return json(
      chatCompletionResponse({
        id: input.id,
        created: input.created,
        model: input.prepared.model,
        text: output.text,
        toolCalls,
        promptChars: input.prepared.promptChars,
        metadata: input.prepared.responseMetadata
      })
    );
  }

  const response = responseObject({
    id: input.id,
    created: input.created,
    model: input.prepared.model,
    text: output.text,
    toolCalls,
    promptChars: input.prepared.promptChars,
    metadata: input.prepared.responseMetadata
  });
  if (input.responseOwner) {
    storeResponseState(input.responseOwner, {
      id: input.id,
      response,
      inputItems: input.prepared.responseInputItems ?? [],
      outputItems: (response.output as unknown[]) ?? [],
      store: input.prepared.storeResponse !== false,
      sdkSessionKey: input.sdkSessionKey,
      now: input.deps.now().getTime()
    });
  }
  return json(response);
}

function shouldUseSdkForPreparedRoute(env: Env, route: CompletionRoute): boolean {
  if (!hasConfiguredSdkBridge(env)) return false;
  if (route.surface === "opencode") return false;
  return route.kind === "responses" || route.kind === "chat";
}

function hasConfiguredSdkBridge(env: Env): boolean {
  return Boolean(env.CURSOR_SDK_BRIDGE_URL?.trim());
}

async function handleOpenCodeSdkChatRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  deps: Deps,
  auth: AuthResult,
  body: unknown,
  cursorModel: { id: string } | undefined
): Promise<Response> {
  const prepared = prepareOpencodeSdkChatRequest(body, cursorModel);
  const id = `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(deps.now().getTime() / 1000);
  const finishLog = (_input: FinishLogInput): Promise<void> => Promise.resolve();

  try {
    const completion = await createCursorSdkCompletion(env, deps, auth.cursorApiKey, {
      prompt: prepared.prompt,
      model: prepared.cursorModel,
      sessionKey: sessionAffinity(request),
      sessionOwnerKey: sdkSessionOwner(auth),
      workingDirectory: prepared.toolContext?.workingDirectory,
      clientTools: prepared.tools,
      requiresLocalTool: prepared.requiresLocalTool,
      allowToolCall: (toolCall) => {
        const toolCalls = toOpenAiToolCalls({
          toolCalls: [toolCall],
          tools: prepared.tools,
          responseId: "probe",
          context: prepared.toolContext
        });
        return toolCalls.length > 0
          || toolCallRetryHint({ toolCall, tools: prepared.tools, context: prepared.toolContext });
      }
    });

    if (prepared.stream) {
      return streamOpenAiEvents("chat", completion.stream, {
        id,
        created,
        model: prepared.model,
        promptChars: prepared.promptChars,
        includeUsage: prepared.includeUsage,
        metadata: prepared.responseMetadata,
        tools: prepared.tools,
        context: prepared.toolContext,
        onDone: (_text, completionChars) =>
          finishLog({
            status: "completed",
            completionChars,
            cursorAgentId: completion.agentId,
            cursorRunId: completion.runId
          }),
        onError: (error) =>
          finishLog({
            status: "error",
            error: error instanceof Error ? error.message : String(error),
            cursorAgentId: completion.agentId,
            cursorRunId: completion.runId
          })
      }, ctx);
    }

    const output = await collectCursorSdkOutput(completion.stream);
    const toolCalls = toOpenAiToolCalls({
      toolCalls: output.toolCalls,
      tools: prepared.tools,
      responseId: id,
      context: prepared.toolContext
    });
    const completionChars = completionCharsFromOutput(output.text, toolCalls);
    await finishLog({
      status: "completed",
      completionChars,
      cursorAgentId: completion.agentId,
      cursorRunId: completion.runId
    });
    return json(
      chatCompletionResponse({
        id,
        created,
        model: prepared.model,
        text: output.text,
        toolCalls,
        promptChars: prepared.promptChars,
        metadata: prepared.responseMetadata
      })
    );
  } catch (error) {
    await finishLog({
      status: "error",
      error: error instanceof Error ? error.message : String(error)
    }).catch(() => undefined);
    throw error;
  }
}

function streamOpenAiResponse(
  kind: "chat" | "responses",
  cursorStream: Response,
  input: {
    id: string;
    created: number;
    model: string;
    promptChars: number;
    includeUsage: boolean;
    metadata?: Record<string, unknown>;
    tools: OpenAiToolSpec[];
    context?: ToolCallContext;
    onDone: (text: string, completionChars: number, toolCalls: ReturnType<typeof toOpenAiToolCalls>) => Promise<void>;
    onError: (error: unknown) => Promise<void>;
  },
  ctx: ExecutionContext
): Response {
  return streamOpenAiEvents(kind, streamCursorText(cursorStream), input, ctx);
}

function streamOpenAiEvents(
  kind: "chat" | "responses",
  cursorEvents: AsyncIterable<CursorTextEvent>,
  input: {
    id: string;
    created: number;
    model: string;
    promptChars: number;
    includeUsage: boolean;
    metadata?: Record<string, unknown>;
    tools: OpenAiToolSpec[];
    context?: ToolCallContext;
    onDone: (text: string, completionChars: number, toolCalls: ReturnType<typeof toOpenAiToolCalls>) => Promise<void>;
    onError: (error: unknown) => Promise<void>;
  },
  ctx: ExecutionContext
): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const pump = async () => {
    let text = "";
    let toolCallCount = 0;
    let finishReason: "stop" | "tool_calls" = "stop";
    const streamedToolCalls: ReturnType<typeof toOpenAiToolCalls> = [];
    let responseNextOutputIndex = 0;
    let responseTextOutputIndex: number | null = null;
    try {
      if (kind === "chat") {
        await writer.write(chatChunk({ id: input.id, created: input.created, model: input.model, role: "assistant" }));
      } else {
        for (const event of responseCreatedEvents(input)) await writer.write(event);
      }

      for await (const event of cursorEvents) {
        if (event.type === "text" && event.text) {
          text += event.text;
          if (kind === "chat") await writer.write(chatChunk({ id: input.id, created: input.created, model: input.model, delta: event.text }));
          else {
            if (responseTextOutputIndex === null) {
              responseTextOutputIndex = responseNextOutputIndex;
              responseNextOutputIndex += 1;
              for (const chunk of responseTextStartEvents({ id: input.id, outputIndex: responseTextOutputIndex })) await writer.write(chunk);
            }
            await writer.write(responseDeltaEvent({ id: input.id, delta: event.text, outputIndex: responseTextOutputIndex }));
          }
        }
        if (event.type === "tool_call") {
          const [toolCall] = toOpenAiToolCalls({
            toolCalls: [event.toolCall],
            tools: input.tools,
            responseId: input.id,
            startIndex: toolCallCount,
            context: input.context
          });
          if (!toolCall) continue;
          finishReason = "tool_calls";
          streamedToolCalls.push(toolCall);
          if (kind === "chat") {
            await writer.write(chatChunk({ id: input.id, created: input.created, model: input.model, toolCall: { index: toolCallCount, value: toolCall } }));
          } else {
            for (const chunk of responseToolCallEvents({ id: input.id, toolCall, outputIndex: responseNextOutputIndex })) await writer.write(chunk);
            responseNextOutputIndex += 1;
          }
          toolCallCount += 1;
        }
        if (event.type === "done") {
          text = event.finalText;
        }
      }

      if (kind === "chat") {
        const completionChars = completionCharsFromOutput(text, streamedToolCalls);
        await writer.write(chatChunk({ id: input.id, created: input.created, model: input.model, finish: true, finishReason }));
        if (input.includeUsage) {
          await writer.write(
            chatUsageChunk({
              id: input.id,
              created: input.created,
              model: input.model,
              promptChars: input.promptChars,
              completionChars
            })
          );
        }
        await writer.write(doneChunk());
      } else {
        if (responseTextOutputIndex === null && !streamedToolCalls.length) {
          responseTextOutputIndex = responseNextOutputIndex;
          responseNextOutputIndex += 1;
          for (const chunk of responseTextStartEvents({ id: input.id, outputIndex: responseTextOutputIndex })) await writer.write(chunk);
        }
        for (const event of responseDoneEvents({
          ...input,
          text,
          toolCalls: streamedToolCalls,
          textStarted: responseTextOutputIndex !== null,
          textOutputIndex: responseTextOutputIndex ?? 0
        })) await writer.write(event);
      }
      await input.onDone(text, completionCharsFromOutput(text, streamedToolCalls), streamedToolCalls);
    } catch (error) {
      await input.onError(error);
      await writer.write(encodeSse({ error: streamErrorPayload(error) }, "error"));
    } finally {
      await writer.close().catch(() => undefined);
    }
  };
  ctx.waitUntil(pump());
  return sseResponse(readable);
}

// A streamed response has already committed HTTP 200, so this frame is the only
// place left to say what failed. Carry the upstream status and code through:
// without them a client cannot tell an expired key from a transient fault.
function streamErrorPayload(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : "Stream failed";
  if (error instanceof HttpError) {
    return { message, type: "cursor_error", code: error.code, status: error.status };
  }
  return { message, type: "cursor_error", code: "cursor_stream_error" };
}

function sessionAffinity(request: Request): string | undefined {
  return (
    request.headers.get("x-session-affinity") ||
    request.headers.get("x-opencode-session-id") ||
    request.headers.get("x-opencode-session")
  )?.trim() || undefined;
}

function sdkSessionOwner(auth: AuthResult): string | undefined {
  return `cursor:${auth.cursorKeyId}`;
}

async function handleResponseStateRoute(request: Request, auth: AuthResult, route: OpenAiRoute): Promise<Response> {
  if (!route.responseId) return notFound();
  const ownerKey = await responseOwnerKey(auth);
  const state = getResponseState(ownerKey, route.responseId);
  if (!state) throw new HttpError("Response not found", 404, "not_found");

  if (route.kind === "response") {
    if (request.method === "GET" || request.method === "HEAD") {
      if (!state.response) throw new HttpError("Response not found", 404, "not_found");
      return json(state.response);
    }
    if (request.method === "DELETE") {
      responseState.delete(responseStateKey(ownerKey, route.responseId));
      return json({ id: route.responseId, object: "response", deleted: true });
    }
    return notFound();
  }

  if (route.kind === "responseInputItems") {
    if (request.method !== "GET" && request.method !== "HEAD") return notFound();
    if (!state.response) throw new HttpError("Response not found", 404, "not_found");
    return json(responseInputItemsObject(state.inputItems));
  }

  if (route.kind === "responseCancel") {
    if (request.method !== "POST") return notFound();
    throw new HttpError("Only background responses can be cancelled. API for Cursor runs responses synchronously.", 400, "invalid_request_error");
  }

  return notFound();
}

function previousResponseIdFromBody(body: unknown): string | undefined {
  if (!isRecordLike(body)) return undefined;
  const value = body.previous_response_id;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function responseOwnerKey(auth: AuthResult): string {
  return `cursor:${auth.cursorKeyId}`;
}

function getResponseState(ownerKey: string, responseId: string): StoredResponseState | undefined {
  return responseState.get(responseStateKey(ownerKey, responseId));
}

function storeResponseState(
  ownerKey: string,
  input: {
    id: string;
    response: Record<string, unknown>;
    inputItems: unknown[];
    outputItems: unknown[];
    store: boolean;
    sdkSessionKey?: string;
    now: number;
  }
) {
  const key = responseStateKey(ownerKey, input.id);
  responseState.set(key, {
    ownerKey,
    id: input.id,
    response: input.store ? input.response : undefined,
    inputItems: input.store ? input.inputItems : [],
    outputItems: input.outputItems,
    sdkSessionKey: input.sdkSessionKey,
    updatedAt: input.now
  });
  pruneResponseState();
}

function responseStateKey(ownerKey: string, responseId: string): string {
  return `${ownerKey}:${responseId}`;
}

function pruneResponseState() {
  if (responseState.size <= RESPONSE_STATE_LIMIT) return;
  const entries = [...responseState.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  for (const [key] of entries.slice(0, responseState.size - RESPONSE_STATE_LIMIT)) {
    responseState.delete(key);
  }
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function authenticate(request: Request, env: Env, _deps: Deps): Promise<AuthResult | null> {
  const token = bearerToken(request);

  // Relay-key only: no bearer, or any non `sk-` bearer (e.g. a raw Cursor key),
  // is rejected. A Cursor key is never accepted or forwarded from the edge.
  if (!token || !token.startsWith("sk-")) return null;

  const resolved = await resolveRelayKey(env, token);
  if (!resolved) return null;
  return {
    mode: "relay",
    cursorKeyId: resolved.cursorKeyId,
    relayKeyId: resolved.relayKeyId,
    cursorApiKey: resolved.cursorApiKey
  };
}

function rememberAuth(log: AccessLogDraft, auth: AuthResult | null): void {
  if (!auth) return;
  log.relayKeyId = auth.relayKeyId;
  log.cursorKeyId = auth.cursorKeyId;
}

async function withAccessLog(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
  url: URL,
  handler: (log: AccessLogDraft) => Promise<Response>
): Promise<Response> {
  const started = Date.now();
  const log: AccessLogDraft = {};
  try {
    const response = await handler(log);
    ctx.waitUntil(recordAccessLog(env, request, url, response, started, log));
    return response;
  } catch (error) {
    const response = errorResponse(error);
    log.error = error instanceof Error ? error.message.slice(0, 240) : "Unexpected error";
    ctx.waitUntil(recordAccessLog(env, request, url, response, started, log));
    return response;
  }
}

async function recordAccessLog(
  env: Env,
  request: Request,
  url: URL,
  response: Response,
  started: number,
  log: AccessLogDraft
): Promise<void> {
  const error = log.error || (await errorSnippet(response));
  await insertAccessLog(env, {
    method: request.method,
    path: url.pathname,
    status: response.status,
    durationMs: Math.max(0, Date.now() - started),
    clientIp: clientIp(request),
    relayKeyId: log.relayKeyId,
    cursorKeyId: log.cursorKeyId,
    model: log.model,
    error
  });
}

async function errorSnippet(response: Response): Promise<string | null> {
  if (response.status < 400) return null;
  try {
    const text = (await response.clone().text()).slice(0, 240);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown };
      const message = parsed.error?.message ?? parsed.message;
      if (typeof message === "string" && message.trim()) return message.slice(0, 240);
    } catch {
      /* raw text below */
    }
    return text.trim() || null;
  } catch {
    return null;
  }
}

function clientIp(request: Request): string | null {
  const cf = request.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || null;
}

function listenHostField(value: unknown, field: string): string {
  try {
    return parseListenHost(value);
  } catch (error) {
    throw new HttpError(error instanceof Error ? error.message : "Invalid host", 400, "invalid_request_error", field);
  }
}

function listenPortField(value: unknown, field: string): number {
  try {
    return parseListenPort(value);
  } catch (error) {
    throw new HttpError(error instanceof Error ? error.message : "Invalid port", 400, "invalid_request_error", field);
  }
}

async function probeSdkBridge(
  deps: Deps,
  config: AppConfig
): Promise<{
  status: "up" | "down";
  durationMs: number;
  agents?: number;
  host?: string;
  port?: number;
  url?: string;
  error?: string;
}> {
  const started = Date.now();
  try {
    const response = await deps.fetch(`${sdkControlOrigin(config)}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(2000)
    });
    const durationMs = Date.now() - started;
    if (!response.ok) {
      return { status: "down", durationMs, error: `HTTP ${response.status}` };
    }
    const body = (await response.json()) as {
      agents?: unknown;
      host?: unknown;
      port?: unknown;
      url?: unknown;
    };
    return {
      status: "up",
      durationMs,
      agents: typeof body.agents === "number" ? body.agents : undefined,
      host: typeof body.host === "string" ? body.host : undefined,
      port: typeof body.port === "number" ? body.port : undefined,
      url: typeof body.url === "string" ? body.url : undefined
    };
  } catch (error) {
    return {
      status: "down",
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : "unreachable"
    };
  }
}

async function postSdkListen(
  deps: Deps,
  config: AppConfig,
  listen: { host: string; port: number }
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await deps.fetch(`${sdkControlOrigin(config)}/listen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(listen),
      signal: AbortSignal.timeout(4000)
    });
    if (response.ok) {
      const body = (await response.json().catch(() => ({}))) as { ok?: unknown };
      if (body.ok !== false) return { ok: true };
    }
    return {
      ok: false,
      error: `SDK 换绑失败（HTTP ${response.status}），请重启 npm run dev`
    };
  } catch {
    return { ok: false, error: "无法连接 SDK 桥，请重启 npm run dev" };
  }
}

async function postRelayRebind(
  deps: Deps,
  origin: string,
  listen: { host: string; port: number }
): Promise<{ ok: boolean; newOrigin?: string; appliedOnNextStart: boolean; error?: string }> {
  try {
    const response = await deps.fetch(`${origin}/__station/rebind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(listen),
      signal: AbortSignal.timeout(4000)
    });
    if (!response.ok) {
      return { ok: false, appliedOnNextStart: true, error: "下次启动生效" };
    }
    const body = (await response.json().catch(() => ({}))) as { ok?: unknown; newOrigin?: unknown };
    if (body.ok !== true) {
      return { ok: false, appliedOnNextStart: true, error: "下次启动生效" };
    }
    return {
      ok: true,
      appliedOnNextStart: false,
      newOrigin: typeof body.newOrigin === "string" ? body.newOrigin : undefined
    };
  } catch {
    return { ok: false, appliedOnNextStart: true, error: "下次启动生效" };
  }
}

async function postJson(
  deps: Deps,
  url: string,
  body: Record<string, unknown>
): Promise<boolean> {
  try {
    const response = await deps.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2500)
    });
    return response.ok;
  } catch {
    return false;
  }
}

function isLocalDevOrigin(url: URL): boolean {
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "0.0.0.0";
}

async function syncListenersOnce(deps: Deps, url: URL, config: AppConfig): Promise<void> {
  if (listenersSynced) return;
  listenersSynced = true;
  const defaultSdkListen = `http://${APP_CONFIG_DEFAULTS.sdkListenHost}:${APP_CONFIG_DEFAULTS.sdkListenPort}/listen`;
  const currentSdkListen = `${sdkControlOrigin(config)}/listen`;
  const sdkNeedsMove =
    config.sdkListenHost !== APP_CONFIG_DEFAULTS.sdkListenHost ||
    config.sdkListenPort !== APP_CONFIG_DEFAULTS.sdkListenPort;
  if (sdkNeedsMove) {
    const seen = new Set<string>();
    for (const endpoint of [defaultSdkListen, currentSdkListen]) {
      if (seen.has(endpoint)) continue;
      seen.add(endpoint);
      if (await postJson(deps, endpoint, { host: config.sdkListenHost, port: config.sdkListenPort })) break;
    }
  }
  if (isLocalDevOrigin(url)) {
    const currentPort = Number(url.port || (url.protocol === "https:" ? "443" : "80"));
    if (currentPort !== config.relayListenPort) {
      await postJson(deps, `${url.origin}/__station/rebind`, {
        host: config.relayListenHost,
        port: config.relayListenPort
      });
    }
  }
}

interface OpenAiRoute {
  kind: "chat" | "responses" | "models" | "response" | "responseInputItems" | "responseCancel";
  responseId?: string;
  surface?: "standard" | "opencode" | "opencodev2";
}

type CompletionRoute = OpenAiRoute & { kind: "chat" | "responses" };

function matchOpenAiRoute(pathname: string): OpenAiRoute | null {
  const opencodePath = pathname.startsWith("/opencode/v1/") ? pathname.slice("/opencode/v1".length) : "";
  if (opencodePath === "/chat/completions") return { kind: "chat", surface: "opencode" };
  if (opencodePath === "/models") return { kind: "models", surface: "opencode" };
  const opencodeV2Path = pathname.startsWith("/opencodev2/v1/") ? pathname.slice("/opencodev2/v1".length) : "";
  if (opencodeV2Path === "/chat/completions") return { kind: "chat", surface: "opencodev2" };
  if (opencodeV2Path === "/models") return { kind: "models", surface: "opencodev2" };

  // Relay keys and direct keys all hit the canonical `/v1/...` base URL.
  const path = pathname.startsWith("/v1/") ? pathname.slice(3) : "";
  if (path === "/chat/completions") return { kind: "chat" };
  if (path === "/responses") return { kind: "responses" };
  const responseInputItemsMatch = /^\/responses\/([^/]+)\/input_items\/?$/.exec(path);
  if (responseInputItemsMatch) return { kind: "responseInputItems", responseId: responseInputItemsMatch[1] };
  const responseCancelMatch = /^\/responses\/([^/]+)\/cancel\/?$/.exec(path);
  if (responseCancelMatch) return { kind: "responseCancel", responseId: responseCancelMatch[1] };
  const responseMatch = /^\/responses\/([^/]+)\/?$/.exec(path);
  if (responseMatch) return { kind: "response", responseId: responseMatch[1] };
  if (path === "/models") return { kind: "models" };
  return null;
}

function isDocumentRequest(request: Request, url: URL): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const accept = request.headers.get("accept") || "";
  return url.pathname === "/" || accept.includes("text/html");
}
