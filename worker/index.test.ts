import { describe, expect, it } from "vitest";
import { resetCursorSdkSessionCacheForTest } from "./cursor-sdk";
import { handleRequest } from "./index";
import { FakeD1, fakeCtx } from "./test-helpers";
import type { Deps, Env } from "./types";

interface MakeEnvOptions {
  assetsFetch?: Fetcher["fetch"];
  consolePassword?: string;
}

function makeEnv(
  db: FakeD1,
  assetsFetchOrOptions: Fetcher["fetch"] | MakeEnvOptions = () => Promise.resolve(new Response("asset"))
): Env {
  const options: MakeEnvOptions =
    typeof assetsFetchOrOptions === "function" ? { assetsFetch: assetsFetchOrOptions } : assetsFetchOrOptions;
  const assetsFetch = options.assetsFetch ?? (() => Promise.resolve(new Response("asset")));
  return {
    DB: db as unknown as D1Database,
    ASSETS: { fetch: assetsFetch } as unknown as Fetcher,
    ENCRYPTION_KEY: "test-encryption-secret-with-enough-entropy",
    CURSOR_API_BASE: "https://api.cursor.test",
    CURSOR_BACKEND_BASE_URL: "https://cursor-backend.test",
    CURSOR_CHAT_ENDPOINT: "/test-cursor-chat",
    CURSOR_CLIENT_VERSION: "2.6.22",
    CURSOR_LOCAL_AGENT_ENDPOINT: "/test-local-sdk",
    CURSOR_SDK_CLIENT_VERSION: "sdk-test",
    CONSOLE_PASSWORD: options.consolePassword
  };
}

function sayHelloRequest(authorization?: string): Request {
  return new Request("https://composer.test/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: authorization } : {})
    },
    body: JSON.stringify({ model: "composer-2.5", messages: [{ role: "user", content: "Say hello" }] })
  });
}

function adminAddCursorKey(
  env: Env,
  deps: Deps,
  opts: { cookie?: string; cursorApiKey?: string; makeDefault?: boolean } = {}
): Promise<Response> {
  return handleRequest(
    new Request("https://composer.test/api/admin/cursor-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(opts.cookie ? { cookie: opts.cookie } : {}) },
      body: JSON.stringify({ cursorApiKey: opts.cursorApiKey ?? "cursor_key", makeDefault: opts.makeDefault ?? true })
    }),
    env,
    fakeCtx(),
    deps
  );
}

function adminListCursorKeys(env: Env, deps: Deps, cookie?: string): Promise<Response> {
  return handleRequest(
    new Request("https://composer.test/api/admin/cursor-keys", { headers: cookie ? { cookie } : {} }),
    env,
    fakeCtx(),
    deps
  );
}

async function firstCursorKeyId(env: Env, deps: Deps, cookie?: string): Promise<string> {
  const listed = (await (await adminListCursorKeys(env, deps, cookie)).json()) as { keys: Array<{ id: string }> };
  return listed.keys[0].id;
}

async function mintRelayKey(
  env: Env,
  deps: Deps,
  opts: { cookie?: string; name?: string; cursorKeyId?: string } = {}
): Promise<string> {
  const cursorKeyId = opts.cursorKeyId ?? (await firstCursorKeyId(env, deps, opts.cookie));
  const created = await handleRequest(
    new Request("https://composer.test/api/admin/relay-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(opts.cookie ? { cookie: opts.cookie } : {}) },
      body: JSON.stringify({ cursorKeyId, name: opts.name ?? "relay" })
    }),
    env,
    fakeCtx(),
    deps
  );
  const body = (await created.json()) as { key: { key: string } };
  return body.key.key;
}

/**
 * Seeds a default Cursor token (defaults to `cursor_key`) and mints one relay
 * key against it, returning the `sk-…` value tests use as their bearer.
 */
async function seedRelayKey(
  env: Env,
  deps: Deps,
  opts: { cursorApiKey?: string; cookie?: string; name?: string } = {}
): Promise<string> {
  await adminAddCursorKey(env, deps, { makeDefault: true, cursorApiKey: opts.cursorApiKey, cookie: opts.cookie });
  return mintRelayKey(env, deps, { cookie: opts.cookie, name: opts.name });
}

function consoleLoginRequest(origin: string, password: string): Request {
  return new Request(`${origin}/api/console/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password })
  });
}

describe("Worker", () => {
  it("allows OpenCode session headers in CORS preflight", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();

    const response = await handleRequest(new Request("https://composer.test/opencode/v1/chat/completions", { method: "OPTIONS" }), env, fakeCtx(), deps);

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-headers")).toContain("x-session-affinity");
    expect(response.headers.get("access-control-allow-headers")).toContain("x-opencode-session-id");
  });

  it("serves current stable Vite assets for stale hashed asset URLs", async () => {
    const db = new FakeD1();
    const requested: string[] = [];
    const env = makeEnv(db, (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requested.push(url.pathname);
      if (url.pathname === "/assets/index.css") {
        return Promise.resolve(new Response("body { color: red; }", { headers: { "content-type": "text/css" } }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    const { deps } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/assets/index-OLDHASH.css"),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/css");
    await expect(response.text()).resolves.toContain("color: red");
    expect(requested).toContain("/assets/index.css");
  });

  it("leaves the console open when no password is configured", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();

    const session = await handleRequest(new Request("https://composer.test/api/console/session"), env, fakeCtx(), deps);
    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toEqual({ authRequired: false, authenticated: true });

    const keys = await adminListCursorKeys(env, deps);
    expect(keys.status).toBe(200);
    await expect(keys.json()).resolves.toEqual({ keys: [] });
  });

  it("gates the admin console behind the password and issues a signed session cookie", async () => {
    const db = new FakeD1();
    const env = makeEnv(db, { consolePassword: "console-secret" });
    const { deps } = fakeDeps();

    const blocked = await adminAddCursorKey(env, deps);
    expect(blocked.status).toBe(401);
    await expect(blocked.json()).resolves.toMatchObject({ error: { message: "Console sign-in required" } });

    const wrong = await handleRequest(consoleLoginRequest("https://composer.test", "nope"), env, fakeCtx(), deps);
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();

    const login = await handleRequest(
      consoleLoginRequest("https://composer.test", "console-secret"),
      env,
      fakeCtx(),
      deps
    );
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie") || "";
    expect(setCookie).toContain("cursor_api_console=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Secure");

    const cookie = setCookie.split(";")[0];
    const session = await handleRequest(
      new Request("https://composer.test/api/console/session", { headers: { cookie } }),
      env,
      fakeCtx(),
      deps
    );
    await expect(session.json()).resolves.toEqual({ authRequired: true, authenticated: true });

    const allowed = await adminAddCursorKey(env, deps, { cookie });
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({ key: { isDefault: true, email: "ada@example.com" } });
  });

  it("rejects tampered or expired console session cookies and clears them on sign-out", async () => {
    const db = new FakeD1();
    const env = makeEnv(db, { consolePassword: "console-secret" });
    const { deps } = fakeDeps();

    const login = await handleRequest(
      consoleLoginRequest("https://composer.test", "console-secret"),
      env,
      fakeCtx(),
      deps
    );
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];

    const tampered = await handleRequest(
      new Request("https://composer.test/api/console/session", { headers: { cookie: `${cookie}x` } }),
      env,
      fakeCtx(),
      deps
    );
    await expect(tampered.json()).resolves.toEqual({ authRequired: true, authenticated: false });

    const { deps: laterDeps } = fakeDeps({ now: () => new Date("2026-05-21T12:00:00.000Z") });
    const expired = await handleRequest(
      new Request("https://composer.test/api/console/session", { headers: { cookie } }),
      env,
      fakeCtx(),
      laterDeps
    );
    await expect(expired.json()).resolves.toEqual({ authRequired: true, authenticated: false });

    const logout = await handleRequest(
      new Request("https://composer.test/api/console/logout", { method: "POST" }),
      env,
      fakeCtx(),
      deps
    );
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("copies the env console password into D1 on first login and then ignores env", async () => {
    const db = new FakeD1();
    const env = makeEnv(db, { consolePassword: "console-secret" });
    const { deps } = fakeDeps();

    const login = await handleRequest(
      consoleLoginRequest("https://composer.test", "console-secret"),
      env,
      fakeCtx(),
      deps
    );
    expect(login.status).toBe(200);
    expect(db.consoleSettings.get("default")?.password_hash).toMatch(/^[0-9a-f]{64}$/);

    env.CONSOLE_PASSWORD = "env-no-longer-used";
    const stillWorks = await handleRequest(
      consoleLoginRequest("https://composer.test", "console-secret"),
      env,
      fakeCtx(),
      deps
    );
    expect(stillWorks.status).toBe(200);

    const envRejected = await handleRequest(
      consoleLoginRequest("https://composer.test", "env-no-longer-used"),
      env,
      fakeCtx(),
      deps
    );
    expect(envRejected.status).toBe(401);
  });

  it("lets an open console set a password, then requires the new session", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();

    const tooShort = await handleRequest(
      new Request("https://composer.test/api/admin/password", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword: "short" })
      }),
      env,
      fakeCtx(),
      deps
    );
    expect(tooShort.status).toBe(400);

    const setPassword = await handleRequest(
      new Request("https://composer.test/api/admin/password", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword: "new-console-pass" })
      }),
      env,
      fakeCtx(),
      deps
    );
    expect(setPassword.status).toBe(200);
    const cookie = (setPassword.headers.get("set-cookie") || "").split(";")[0];
    await expect(setPassword.json()).resolves.toMatchObject({ ok: true, authRequired: true, authenticated: true });

    const blocked = await adminListCursorKeys(env, deps);
    expect(blocked.status).toBe(401);

    const allowed = await adminListCursorKeys(env, deps, cookie);
    expect(allowed.status).toBe(200);
  });

  it("changes the stored console password and invalidates the previous session cookie", async () => {
    const db = new FakeD1();
    const env = makeEnv(db, { consolePassword: "console-secret" });
    const { deps } = fakeDeps();

    const login = await handleRequest(
      consoleLoginRequest("https://composer.test", "console-secret"),
      env,
      fakeCtx(),
      deps
    );
    const oldCookie = (login.headers.get("set-cookie") || "").split(";")[0];

    const wrongCurrent = await handleRequest(
      new Request("https://composer.test/api/admin/password", {
        method: "PUT",
        headers: { "Content-Type": "application/json", cookie: oldCookie },
        body: JSON.stringify({ currentPassword: "nope", newPassword: "rotated-secret" })
      }),
      env,
      fakeCtx(),
      deps
    );
    expect(wrongCurrent.status).toBe(403);

    const changed = await handleRequest(
      new Request("https://composer.test/api/admin/password", {
        method: "PUT",
        headers: { "Content-Type": "application/json", cookie: oldCookie },
        body: JSON.stringify({ currentPassword: "console-secret", newPassword: "rotated-secret" })
      }),
      env,
      fakeCtx(),
      deps
    );
    expect(changed.status).toBe(200);
    const newCookie = (changed.headers.get("set-cookie") || "").split(";")[0];
    expect(newCookie).toContain("cursor_api_console=");

    const stale = await adminListCursorKeys(env, deps, oldCookie);
    expect(stale.status).toBe(401);

    const fresh = await adminListCursorKeys(env, deps, newCookie);
    expect(fresh.status).toBe(200);

    const oldLogin = await handleRequest(
      consoleLoginRequest("https://composer.test", "console-secret"),
      env,
      fakeCtx(),
      deps
    );
    expect(oldLogin.status).toBe(401);

    const newLogin = await handleRequest(
      consoleLoginRequest("https://composer.test", "rotated-secret"),
      env,
      fakeCtx(),
      deps
    );
    expect(newLogin.status).toBe(200);
  });

  it("adds a Cursor key through the admin console without touching legacy accounts", async () => {
    const db = new FakeD1();
    const env = makeEnv(db, { consolePassword: "console-secret" });
    const { deps } = fakeDeps();

    const blocked = await adminAddCursorKey(env, deps);
    expect(blocked.status).toBe(401);

    const login = await handleRequest(
      consoleLoginRequest("https://composer.test", "console-secret"),
      env,
      fakeCtx(),
      deps
    );
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];

    const added = await adminAddCursorKey(env, deps, { cookie });
    expect(added.status).toBe(200);
    const addedBody = (await added.json()) as { key: Record<string, unknown> };
    expect(addedBody.key).toMatchObject({
      email: "ada@example.com",
      name: "Ada Lovelace",
      keyName: "Test key",
      hint: "_key",
      isDefault: true
    });
    expect(JSON.stringify(addedBody)).not.toContain("cursor_key");
    expect(db.cursorKeys.size).toBe(1);

    const listed = await adminListCursorKeys(env, deps, cookie);
    const listedBody = (await listed.json()) as { keys: Array<{ id: string; key?: string }> };
    expect(listedBody.keys[0]?.key).toBeUndefined();

    const revealed = await handleRequest(
      new Request(`https://composer.test/api/admin/cursor-keys/${listedBody.keys[0].id}`, {
        headers: { cookie }
      }),
      env,
      fakeCtx(),
      deps
    );
    expect(revealed.status).toBe(200);
    await expect(revealed.json()).resolves.toMatchObject({
      key: { id: listedBody.keys[0].id, key: "cursor_key", email: "ada@example.com" }
    });
  });

  it("rejects /v1 without a bearer token even when a default Cursor key exists, and stops once the key is deleted", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();

    // With no Cursor token configured, an anonymous browser is rejected.
    const beforeKey = await handleRequest(sayHelloRequest(), env, fakeCtx(), deps);
    expect(beforeKey.status).toBe(401);

    const added = await adminAddCursorKey(env, deps, { makeDefault: true });
    expect(added.status).toBe(200);
    expect(db.cursorKeys.size).toBe(1);
    const relayKey = await mintRelayKey(env, deps);

    // A browser with no Authorization header is still rejected: only sk- relay keys work.
    const anonymous = await handleRequest(sayHelloRequest(), env, fakeCtx(), deps);
    expect(anonymous.status).toBe(401);

    // The minted relay key resolves to the backing Cursor token and succeeds.
    const completion = await handleRequest(sayHelloRequest(`Bearer ${relayKey}`), env, fakeCtx(), deps);
    expect(completion.status).toBe(200);
    await expect(completion.json()).resolves.toMatchObject({
      object: "chat.completion",
      choices: [{ message: { content: "Hello from Composer" } }]
    });

    const keyId = await firstCursorKeyId(env, deps);
    const deleted = await handleRequest(
      new Request(`https://composer.test/api/admin/cursor-keys/${keyId}`, { method: "DELETE" }),
      env,
      fakeCtx(),
      deps
    );
    expect(deleted.status).toBe(200);
    expect(db.cursorKeys.size).toBe(0);

    // The relay key can no longer resolve to a Cursor token, so it is rejected.
    const afterDelete = await handleRequest(sayHelloRequest(`Bearer ${relayKey}`), env, fakeCtx(), deps);
    expect(afterDelete.status).toBe(401);
  });

  it("serves /v1/chat/completions with an sk- relay key without leaking it to Cursor", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps, exchangeAuthHeaders } = fakeDeps();

    await adminAddCursorKey(env, deps, { makeDefault: true });
    const relayKey = await mintRelayKey(env, deps);
    expect(relayKey.startsWith("sk-")).toBe(true);
    expect(db.relayKeys.size).toBe(1);

    const completion = await handleRequest(sayHelloRequest(`Bearer ${relayKey}`), env, fakeCtx(), deps);
    expect(completion.status).toBe(200);
    await expect(completion.json()).resolves.toMatchObject({
      object: "chat.completion",
      choices: [{ message: { content: "Hello from Composer" } }]
    });

    // Only the backing Cursor token is ever exchanged; the sk- key stays server-side.
    expect(exchangeAuthHeaders).toContain("Bearer cursor_key");
    expect(exchangeAuthHeaders).not.toContain(`Bearer ${relayKey}`);
  });

  it("omits the Secure cookie flag over plain http so LAN sign-in works", async () => {
    const db = new FakeD1();
    const env = makeEnv(db, { consolePassword: "console-secret" });
    const { deps } = fakeDeps();

    const login = await handleRequest(
      consoleLoginRequest("http://192.168.1.10:5173", "console-secret"),
      env,
      fakeCtx(),
      deps
    );

    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie") || "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).not.toContain("Secure");
  });

  it("rejects a relay key once it is disabled in the admin console", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();

    await adminAddCursorKey(env, deps, { makeDefault: true });
    const relayKey = await mintRelayKey(env, deps);

    const ok = await handleRequest(sayHelloRequest(`Bearer ${relayKey}`), env, fakeCtx(), deps);
    expect(ok.status).toBe(200);
    await ok.json();

    const relayId = [...db.relayKeys.keys()][0];
    const disabled = await handleRequest(
      new Request(`https://composer.test/api/admin/relay-keys/${relayId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false })
      }),
      env,
      fakeCtx(),
      deps
    );
    expect(disabled.status).toBe(200);

    const rejected = await handleRequest(sayHelloRequest(`Bearer ${relayKey}`), env, fakeCtx(), deps);
    expect(rejected.status).toBe(401);
  });

  it("normalizes tool-call arguments at /v1/chat/completions with a relay key", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();

    await adminAddCursorKey(env, deps, { makeDefault: true });
    const relayKey = await mintRelayKey(env, deps);

    const response = await handleRequest(
      new Request("https://composer.test/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Schema transform" }],
          tools: [
            {
              type: "function",
              function: {
                name: "glob",
                parameters: {
                  type: "object",
                  additionalProperties: false,
                  properties: { pattern: { type: "string" } },
                  required: ["pattern"]
                }
              }
            }
          ]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [
        {
          message: {
            tool_calls: [{ type: "function", function: { name: "glob", arguments: "{\"pattern\":\"**/*.ts\"}" } }]
          },
          finish_reason: "tool_calls"
        }
      ]
    });
  });

  it("serves /v1/chat/completions with a relay key and writes no request log", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps, exchangeAuthHeaders } = fakeDeps();

    const relayKey = await seedRelayKey(env, deps);
    const completion = await handleRequest(
      new Request("https://composer.test/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Say hello" }]
        })
      }),
      env,
      fakeCtx(),
      deps
    );
    expect(completion.status).toBe(200);
    await expect(completion.json()).resolves.toMatchObject({
      object: "chat.completion",
      choices: [{ message: { content: "Hello from Composer" } }]
    });

    // Only the backing Cursor token is exchanged for Cursor API-key authorization.
    expect(exchangeAuthHeaders).toContain("Bearer cursor_key");
  });

  it("keeps the Cursor machine identity stable across API key rotations for the same account", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps, chatRequestHeaders } = fakeDeps();

    // Same account (fake `/v1/me` always returns the same user), so both tokens
    // derive the same Cursor key id. Rotating the backing token in place keeps
    // the relay key valid and the machine identity stable.
    await adminAddCursorKey(env, deps, { cursorApiKey: "cursor_key_one", makeDefault: true });
    const relayKey = await mintRelayKey(env, deps);

    for (const rotated of ["cursor_key_one", "cursor_key_two"]) {
      if (rotated === "cursor_key_two") {
        await adminAddCursorKey(env, deps, { cursorApiKey: "cursor_key_two", makeDefault: true });
      }
      const completion = await handleRequest(
        new Request("https://composer.test/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${relayKey}`
          },
          body: JSON.stringify({
            model: "composer-2.5",
            messages: [{ role: "user", content: "Say hello" }]
          })
        }),
        env,
        fakeCtx(),
        deps
      );
      expect(completion.status).toBe(200);
      await completion.json();
    }

    expect(chatRequestHeaders).toHaveLength(2);
    const machineIds = chatRequestHeaders.map((headers) => headers.get("x-cursor-checksum")?.slice(-64));
    expect(machineIds[0]).toBe(machineIds[1]);
    expect(chatRequestHeaders[0].get("x-cursor-config-version")).toBe(chatRequestHeaders[1].get("x-cursor-config-version"));
  });

  it("streams SSE chat chunks in direct mode when stream is true", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps, exchangeAuthHeaders } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);

    const response = await handleRequest(
      new Request("https://composer.test/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`
        },
        body: JSON.stringify({
          model: "composer-2.5",
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: "user", content: "Say hello" }]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain('"object":"chat.completion.chunk"');
    expect(body).toContain('"content":"Hello from Composer"');
    expect(body).toContain('"finish_reason":"stop"');
    expect(body).toContain('"choices":[]');
    expect(body).toContain('"usage"');
    expect(body).toContain('"total_usd"');
    expect(body).toContain("data: [DONE]");

    expect(exchangeAuthHeaders).toContain("Bearer cursor_key");
  });

  it("streams Composer tool-call markers as OpenAI chat tool calls", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);

    const response = await handleRequest(
      new Request("https://composer.test/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`
        },
        body: JSON.stringify({
          model: "composer-2.5",
          stream: true,
          messages: [{ role: "user", content: "List files" }],
          tools: [
            {
              type: "function",
              function: {
                name: "glob",
                description: "Find files by glob",
                parameters: { type: "object", properties: { glob_pattern: { type: "string" } } }
              }
            }
          ]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"content":"Checking the workspace.\\n"');
    expect(body).toContain('"tool_calls"');
    expect(body).toContain('"name":"glob"');
    expect(body).toContain('"arguments":"{\\"glob_pattern\\":\\"*\\"}"');
    expect(body).toContain('"finish_reason":"tool_calls"');
    expect(body).not.toContain("tool_calls_begin");
  });

  it("buffers Composer tool-call markers as OpenAI chat tool calls", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);

    const response = await handleRequest(
      new Request("https://composer.test/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "List files" }],
          tools: [{ type: "function", function: { name: "glob" } }]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [
        {
          message: {
            content: "Checking the workspace.\n",
            tool_calls: [{ type: "function", function: { name: "glob", arguments: "{\"glob_pattern\":\"*\"}" } }]
          },
          finish_reason: "tool_calls"
        }
      ]
    });
  });

  it("serves OpenCode chat through the SDK harness with tool calls", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps, chatRequestBodies, sdkRequests } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);

    const response = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`,
          "x-session-affinity": "session-one"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: "user", content: "List files" }],
          tools: [
            {
              type: "function",
              function: {
                name: "glob",
                parameters: {
                  type: "object",
                  additionalProperties: false,
                  properties: { pattern: { type: "string" } }
                }
              }
            }
          ]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"object":"chat.completion.chunk"');
    expect(body).toContain('"tool_calls"');
    expect(body).toContain('"name":"glob"');
    expect(body).toContain('"arguments":"{\\"pattern\\":\\"*\\"}"');
    expect(body).toContain('"finish_reason":"tool_calls"');
    expect(body).toContain('"choices":[]');
    expect(body).toContain('"usage"');
    expect(chatRequestBodies).toHaveLength(0);
    expect(sdkRequests.map((item) => `${item.method} ${item.path}`)).toEqual(["POST /test-local-sdk"]);
    expect(String(sdkRequests[0].body)).toContain("agent-");
    expect(String(sdkRequests[0].body)).toContain("SDK-compatible OpenCode harness");
    expect(sdkRequests[0].headers.get("x-cursor-client-type")).toBe("sdk");
    expect(sdkRequests[0].headers.get("x-cursor-client-version")).toBe("sdk-test");
    expect(sdkRequests[0].headers.get("content-type")).toContain("application/connect+proto");
  });

  it("keeps legacy /opencode chat on the Cursor chat endpoint", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps, chatRequestBodies, sdkRequests } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);

    const response = await handleRequest(
      new Request("https://composer.test/opencode/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`,
          "x-session-affinity": "legacy-session"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "List files" }],
          tools: [{ type: "function", function: { name: "glob" } }]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [
        {
          message: {
            content: "Checking the workspace.\n",
            tool_calls: [{ type: "function", function: { name: "glob", arguments: "{\"glob_pattern\":\"*\"}" } }]
          },
          finish_reason: "tool_calls"
        }
      ]
    });
    expect(sdkRequests).toHaveLength(0);
    expect(chatRequestBodies).toHaveLength(1);
    expect(chatRequestBodies[0]).toContain("This request is already in Agent mode");
    expect(chatRequestBodies[0]).toContain("Switched to agent mode successfully.");
    expect(chatRequestBodies[0]).not.toContain("SDK-compatible OpenCode harness");
  });

  it("keeps OpenCode SDK agents stable for a session-affinity header", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps, chatRequestBodies, sdkRequests } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);

    for (const affinity of ["session-one", "session-one", "session-two"]) {
      const response = await handleRequest(
        new Request("https://composer.test/opencodev2/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${relayKey}`,
            "x-session-affinity": affinity
          },
          body: JSON.stringify({
            model: "composer-2.5",
            messages: [{ role: "user", content: "Say hello" }]
          })
        }),
        env,
        fakeCtx(),
        deps
      );
      expect(response.status).toBe(200);
      await response.json();
    }

    expect(chatRequestBodies).toHaveLength(0);
    const paths = sdkRequests.map((item) => `${item.method} ${item.path}`);
    expect(paths).toEqual(["POST /test-local-sdk", "POST /test-local-sdk", "POST /test-local-sdk"]);
    const firstAgent = /agent-[0-9a-f-]{36}/.exec(String(sdkRequests[0].body))?.[0];
    expect(firstAgent).toBeTruthy();
    expect(String(sdkRequests[1].body)).toContain(firstAgent!);
    expect(String(sdkRequests[2].body)).not.toContain(firstAgent!);
    expect(String(sdkRequests[0].body)).toContain("SDK-compatible OpenCode harness");
    expect(String(sdkRequests[0].body)).not.toContain("Switched to agent mode successfully");
  });

  it("does not reuse an OpenCode SDK agent when session affinity is omitted", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps, sdkRequests } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);

    for (const content of ["Topic A", "Topic B"]) {
      const response = await handleRequest(
        new Request("https://composer.test/opencodev2/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${relayKey}`
          },
          body: JSON.stringify({
            model: "composer-2.5",
            messages: [{ role: "user", content }]
          })
        }),
        env,
        fakeCtx(),
        deps
      );
      expect(response.status).toBe(200);
      await response.json();
    }

    expect(sdkRequests).toHaveLength(2);
    const firstAgent = /agent-[0-9a-f-]{36}/.exec(String(sdkRequests[0].body))?.[0];
    expect(firstAgent).toBeTruthy();
    expect(String(sdkRequests[1].body)).not.toContain(firstAgent!);
  });

  it("streams local SDK output from one run", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps, sdkRequests } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);

    const response = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`,
          "x-session-affinity": "retry-session"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Retry dropped stream" }]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: "Partial after retry" }, finish_reason: "stop" }]
    });
    expect(sdkRequests.map((item) => `${item.method} ${item.path}`)).toEqual(["POST /test-local-sdk"]);
  });

  it("retries schema-invalid SDK tool calls even when no local tool was required", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps, sdkRequests } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);

    const response = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`,
          "x-session-affinity": "invalid-retry-session"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Retry invalid mapped tool" }],
          tools: [
            {
              type: "function",
              function: {
                name: "mcp__github__create_issue",
                parameters: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    title: { type: "string" },
                    body: { type: "string" }
                  },
                  required: ["title"]
                }
              }
            }
          ]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: "Partial after retry" }, finish_reason: "stop" }]
    });
    expect(sdkRequests.map((item) => `${item.method} ${item.path}`)).toEqual(["POST /test-local-sdk", "POST /test-local-sdk"]);
    expect(String(sdkRequests[1].body)).toContain("Mapping failure detail");
    expect(String(sdkRequests[1].body)).toContain("Required client arguments");
    expect(String(sdkRequests[1].body)).toContain("title:string");
  });

  it("can route OpenCode SDK runs through a standard streaming bridge", async () => {
    const db = new FakeD1();
    const env = { ...makeEnv(db), CURSOR_SDK_BRIDGE_URL: "https://bridge.test/sdk" };
    const { deps, sdkRequests } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);

    const response = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`,
          "x-session-affinity": "bridge-session"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Say hello" }],
          tools: [
            {
              type: "function",
              function: {
                name: "probe_write_file",
                description: "Writes a file through the harness MCP server.",
                parameters: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    file_path: { type: "string" },
                    contents: { type: "string" }
                  },
                  required: ["file_path", "contents"]
                }
              }
            }
          ]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: "Hello from SDK" }, finish_reason: "stop" }]
    });
    expect(sdkRequests.map((item) => `${item.method} ${item.path}`)).toEqual(["POST /sdk"]);
    expect(sdkRequests[0].headers.get("content-type")).toContain("application/json");
    expect(sdkRequests[0].body).toMatchObject({
      apiKey: "cursor_key",
      model: "composer-2.5"
    });
    expect((sdkRequests[0].body as { tools?: unknown[] }).tools).toEqual([
      {
        name: "probe_write_file",
        description: "Writes a file through the harness MCP server.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            file_path: { type: "string" },
            contents: { type: "string" }
          },
          required: ["file_path", "contents"]
        }
      }
    ]);
    expect(String((sdkRequests[0].body as { prompt?: string }).prompt || "")).toContain("SDK-compatible OpenCode harness");
  });

  it("times out stalled standard SDK bridge requests", async () => {
    const db = new FakeD1();
    const base = fakeDeps();
    const env = {
      ...makeEnv(db),
      CURSOR_SDK_BRIDGE_URL: "https://bridge-timeout.test/sdk",
      CURSOR_SDK_BRIDGE_TIMEOUT_MS: "5"
    };
    const deps: Deps = {
      ...base.deps,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.hostname === "bridge-timeout.test" && url.pathname === "/sdk") {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
        return base.deps.fetch(input, init);
      }
    };
    const relayKey = await seedRelayKey(env, deps);

    const response = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`,
          "x-session-affinity": "bridge-timeout-session"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Say hello" }]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "cursor_sdk_bridge_timeout"
      }
    });
  });

  it("surfaces SDK bridge authorization failures as 401", async () => {
    const db = new FakeD1();
    const base = fakeDeps();
    const env = { ...makeEnv(db), CURSOR_SDK_BRIDGE_URL: "https://bridge-auth.test/sdk" };
    const deps: Deps = {
      ...base.deps,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.hostname === "bridge-auth.test" && url.pathname === "/sdk") {
          return new Response(
            JSON.stringify({
              error: { message: "Missing or invalid authorization", type: "unauthorized", code: "unauthorized" }
            }),
            { status: 401, headers: { "content-type": "application/json" } }
          );
        }
        return base.deps.fetch(input, init);
      }
    };
    const relayKey = await seedRelayKey(env, deps);

    const response = await handleRequest(
      new Request("https://composer.test/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "ping" }]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        message: "Missing or invalid authorization",
        code: "unauthorized"
      }
    });
  });

  it("carries the upstream status into the SSE error frame when streaming", async () => {
    const db = new FakeD1();
    const base = fakeDeps();
    const env = { ...makeEnv(db), CURSOR_SDK_BRIDGE_URL: "https://bridge-auth.test/sdk" };
    const deps: Deps = {
      ...base.deps,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.hostname === "bridge-auth.test" && url.pathname === "/sdk") {
          return new Response(
            JSON.stringify({
              error: { message: "Missing or invalid authorization", type: "unauthorized", code: "unauthorized" }
            }),
            { status: 401, headers: { "content-type": "application/json" } }
          );
        }
        return base.deps.fetch(input, init);
      }
    };
    const relayKey = await seedRelayKey(env, deps);

    const response = await handleRequest(
      new Request("https://composer.test/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`
        },
        body: JSON.stringify({
          model: "composer-2.5",
          stream: true,
          messages: [{ role: "user", content: "ping" }]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    // The transport already committed 200, so the frame is the only place a
    // client can learn the key was rejected rather than the stream glitching.
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("event: error");
    const frame = body.split("event: error")[1] ?? "";
    const payload = JSON.parse(frame.slice(frame.indexOf("{"), frame.lastIndexOf("}") + 1));
    expect(payload.error).toMatchObject({
      message: "Missing or invalid authorization",
      code: "unauthorized",
      status: 401
    });
  });

  it("routes loopback SDK bridge URLs to the local Node listen address", async () => {
    const db = new FakeD1();
    const env = { ...makeEnv(db), CURSOR_SDK_BRIDGE_URL: "http://127.0.0.1:8792/sdk" };
    const { deps, chatRequestBodies, sdkRequests } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);
    const originalFetch = deps.fetch;
    deps.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === "127.0.0.1" && url.port === "8792" && url.pathname === "/sdk" && init?.method === "POST") {
        const headers = new Headers(init.headers);
        const body = JSON.parse(String(init.body || "{}")) as Record<string, unknown>;
        sdkRequests.push({ method: "POST", path: url.pathname, headers, body });
        return localSdkBridgeJsonResponse(sdkRunKind(typeof body.prompt === "string" ? body.prompt : ""));
      }
      return originalFetch(input, init);
    };

    const response = await handleRequest(
      new Request("http://127.0.0.1:5173/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Say hello" }]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: "Hello from SDK" }, finish_reason: "stop" }]
    });
    expect(chatRequestBodies).toHaveLength(0);
    expect(sdkRequests.map((item) => `${item.method} ${item.path}`)).toEqual(["POST /sdk"]);
  });

  it("omits placeholder working directories from local SDK bridge requests", async () => {
    const db = new FakeD1();
    const bridgeRequests: Array<{ body: Record<string, unknown> }> = [];
    const env = {
      ...makeEnv(db),
      CURSOR_SDK_BRIDGE_URL: "https://bridge.test/sdk",
      CURSOR_SDK_BRIDGE_TOKEN: "bridge-token"
    };
    const { deps } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);
    const originalFetch = deps.fetch;
    deps.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === "bridge.test" && url.pathname === "/sdk") {
        const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
        bridgeRequests.push({ body });
      }
      return originalFetch(input, init);
    };

    const response = await handleRequest(
      new Request("https://composer.test/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Say hello" }]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    expect(bridgeRequests).toHaveLength(1);
    expect(bridgeRequests[0].body).not.toHaveProperty("workingDirectory");
  });

  it("persists OpenCode SDK sessions in D1 across isolate cache resets", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const firstDeps = fakeDeps();
    const relayKey = await seedRelayKey(env, firstDeps.deps);

    const first = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`,
          "x-session-affinity": "persisted-session"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Say hello" }]
        })
      }),
      env,
      fakeCtx(),
      firstDeps.deps
    );
    expect(first.status).toBe(200);
    await first.json();
    expect(db.sdkSessions.size).toBe(1);

    resetCursorSdkSessionCacheForTest();
    const secondDeps = fakeDeps();
    const second = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`,
          "x-session-affinity": "persisted-session"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Say hello again" }]
        })
      }),
      env,
      fakeCtx(),
      secondDeps.deps
    );

    expect(second.status).toBe(200);
    await second.json();
    expect(secondDeps.sdkRequests.map((item) => `${item.method} ${item.path}`)).toEqual(["POST /test-local-sdk"]);
    const persistedAgent = [...db.sdkSessions.values()][0]?.agent_id;
    expect(String(secondDeps.sdkRequests[0].body)).toContain(persistedAgent);
  });

  it("feeds OpenCode tool results back to the SDK run as SDK-shaped tool output", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps, sdkRequests } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);

    const response = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`,
          "x-session-affinity": "tool-result-session"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [
            { role: "user", content: "Run tests" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_shell_1",
                  type: "function",
                  function: { name: "bash", arguments: "{\"command\":\"npm test\"}" }
                }
              ]
            },
            {
              role: "tool",
              tool_call_id: "call_shell_1",
              name: "bash",
              content: "{\"exitCode\":0,\"stdout\":\"tests passed\",\"stderr\":\"\",\"executionTime\":123}"
            }
          ]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: "Tool result incorporated" }, finish_reason: "stop" }]
    });
    const prompt = String(sdkRequests[0].body);
    expect(prompt).toContain("LOCAL OPENCODE TOOL RESULT");
    expect(prompt).toContain("\"name\":\"shell\"");
    expect(prompt).toContain("\"status\":\"completed\"");
    expect(prompt).toContain("\"stdout\":\"tests passed\"");
  });

  it("maps SDK shell calls to OpenCode bash schema including required defaults", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);

    const response = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`,
          "x-session-affinity": "shell-session"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Run shell command" }],
          tools: [
            {
              type: "function",
              function: {
                name: "bash",
                parameters: {
                  type: "object",
                  properties: {
                    command: { type: "string" },
                    workdir: { type: "string" },
                    description: { type: "string" }
                  },
                  required: ["command", "description"]
                }
              }
            }
          ]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices: Array<{ message: { tool_calls: Array<{ function: { arguments: string } }> } }> };
    const args = JSON.parse(body.choices[0].message.tool_calls[0].function.arguments) as Record<string, unknown>;
    expect(args).toEqual({
      command: "npm test",
      description: "Runs npm test"
    });
  });

  it("does not return completed SDK tool-result updates as fresh OpenCode tool calls", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps, chatRequestBodies, sdkRequests } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);

    const response = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`,
          "x-session-affinity": "completed-tool"
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Completed SDK tool result" }],
          tools: [
            {
              type: "function",
              function: {
                name: "read",
                parameters: {
                  type: "object",
                  properties: { filePath: { type: "string" } }
                }
              }
            }
          ]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices: Array<{ message: { content: string; tool_calls?: unknown[] }; finish_reason: string }> };
    expect(body.choices[0].message.content).toBe("Done after cloud result");
    expect(body.choices[0].message.tool_calls).toBeUndefined();
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(chatRequestBodies).toHaveLength(0);
    expect(sdkRequests.map((item) => `${item.method} ${item.path}`)).toEqual(["POST /test-local-sdk"]);
  });

  it("labels the OpenCode model without changing the standard model list", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);

    const standard = await handleRequest(
      new Request("https://composer.test/v1/models", {
        headers: { Authorization: `Bearer ${relayKey}` }
      }),
      env,
      fakeCtx(),
      deps
    );
    const opencodeLegacy = await handleRequest(
      new Request("https://composer.test/opencode/v1/models", {
        headers: { Authorization: `Bearer ${relayKey}` }
      }),
      env,
      fakeCtx(),
      deps
    );
    const opencodeSdk = await handleRequest(
      new Request("https://composer.test/opencodev2/v1/models", {
        headers: { Authorization: `Bearer ${relayKey}` }
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(standard.status).toBe(200);
    expect(opencodeLegacy.status).toBe(200);
    expect(opencodeSdk.status).toBe(200);
    const standardBody = (await standard.json()) as { data: Array<{ id: string; name: string; cost?: { input: number; output: number } }> };
    const opencodeLegacyBody = (await opencodeLegacy.json()) as { data: Array<{ id: string; name: string; cost?: { input: number; output: number } }> };
    const opencodeSdkBody = (await opencodeSdk.json()) as { data: Array<{ id: string; name: string; cost?: { input: number; output: number } }> };
    expect(standardBody.data.find((model) => model.id === "composer-2.5")?.name).toBe("Composer 2.5");
    expect(standardBody.data.map((model) => model.id)).toContain("claude-opus-5");
    expect(standardBody.data.map((model) => model.id)).not.toContain("composer-2.5-sdk");
    expect(opencodeLegacyBody.data.find((model) => model.id === "composer-2.5")?.name).toBe("Composer 2.5");
    expect(opencodeLegacyBody.data.map((model) => model.id)).not.toContain("composer-2.5-sdk");
    expect(opencodeSdkBody.data.find((model) => model.id === "composer-2.5")?.name).toBe("Composer 2.5");
    expect(opencodeSdkBody.data.find((model) => model.id === "composer-2.5-sdk")?.name).toBe("Composer 2.5 SDK Harness");
    expect(opencodeSdkBody.data.find((model) => model.id === "composer-2.5")?.cost).toEqual({ input: 0.5, output: 2.5 });
    expect(opencodeSdkBody.data.find((model) => model.id === "grok-4.6")?.cost).toEqual({ input: 2, output: 6 });
    expect(opencodeSdkBody.data.find((model) => model.id === "grok-4.6-fast")?.cost).toEqual({ input: 4, output: 12 });
  });

  it("streams SSE response events in direct mode for /v1/responses", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);

    const response = await handleRequest(
      new Request("https://composer.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`
        },
        body: JSON.stringify({ model: "composer-2.5", stream: true, input: "Say hello" })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain("event: response.created");
    expect(body).toContain("event: response.output_text.delta");
    expect(body).toContain("event: response.completed");
    expect(body).toContain("Hello from Composer");
  });

  it("returns a buffered JSON response for /v1/responses when stream is absent", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);

    const response = await handleRequest(
      new Request("https://composer.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`
        },
        body: JSON.stringify({ model: "composer-2.5", input: "Say hello" })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toMatchObject({
      object: "response",
      output: [{ type: "message", content: [{ type: "output_text", text: "Hello from Composer" }] }]
    });
  });

  it("uses the SDK bridge for standard Responses when configured", async () => {
    const db = new FakeD1();
    const env = { ...makeEnv(db), CURSOR_SDK_BRIDGE_URL: "https://bridge.test/sdk" };
    const { deps, chatRequestBodies, sdkRequests } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);

    const response = await handleRequest(
      new Request("https://composer.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`,
          "x-session-affinity": "responses-sdk-session"
        },
        body: JSON.stringify({ model: "composer-2.5", input: "Say hello" })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      object: "response",
      output: [{ type: "message", content: [{ type: "output_text", text: "Hello from SDK" }] }]
    });
    expect(chatRequestBodies).toHaveLength(0);
    expect(sdkRequests.map((item) => `${item.method} ${item.path}`)).toEqual(["POST /sdk"]);
    expect(sdkRequests[0].body).toMatchObject({
      apiKey: "cursor_key",
      model: "composer-2.5"
    });
  });

  it("uses the SDK bridge for standard Chat Completions when configured", async () => {
    const db = new FakeD1();
    const env = { ...makeEnv(db), CURSOR_SDK_BRIDGE_URL: "https://bridge.test/sdk" };
    const { deps, chatRequestBodies, sdkRequests } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);

    const response = await handleRequest(
      new Request("https://composer.test/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Say hello" }]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: "Hello from SDK" }, finish_reason: "stop" }]
    });
    expect(chatRequestBodies).toHaveLength(0);
    expect(sdkRequests.map((item) => `${item.method} ${item.path}`)).toEqual(["POST /sdk"]);
    expect(sdkRequests[0].body).toMatchObject({
      apiKey: "cursor_key",
      model: "composer-2.5"
    });
  });

  it("isolates SDK agents for chat completions that omit session affinity", async () => {
    const db = new FakeD1();
    const env = { ...makeEnv(db), CURSOR_SDK_BRIDGE_URL: "https://bridge.test/sdk" };
    const { deps, sdkRequests } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);

    for (const content of ["Topic A: explain rust ownership", "Topic B: write a python fizzbuzz"]) {
      const response = await handleRequest(
        new Request("https://composer.test/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${relayKey}`
          },
          body: JSON.stringify({
            model: "composer-2.5",
            messages: [{ role: "user", content }]
          })
        }),
        env,
        fakeCtx(),
        deps
      );
      expect(response.status).toBe(200);
      await response.json();
    }

    expect(sdkRequests).toHaveLength(2);
    const firstKey = (sdkRequests[0].body as { sessionKey?: string }).sessionKey;
    const secondKey = (sdkRequests[1].body as { sessionKey?: string }).sessionKey;
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBeTruthy();
    expect(firstKey).not.toBe(secondKey);
  });

  it("reuses the SDK agent when chat completions share a session-affinity header", async () => {
    const db = new FakeD1();
    const env = { ...makeEnv(db), CURSOR_SDK_BRIDGE_URL: "https://bridge.test/sdk" };
    const { deps, sdkRequests } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);

    for (const content of ["Say hello", "Say hello again"]) {
      const response = await handleRequest(
        new Request("https://composer.test/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${relayKey}`,
            "x-session-affinity": "chat-session-one"
          },
          body: JSON.stringify({
            model: "composer-2.5",
            messages: [{ role: "user", content }]
          })
        }),
        env,
        fakeCtx(),
        deps
      );
      expect(response.status).toBe(200);
      await response.json();
    }

    expect(sdkRequests).toHaveLength(2);
    expect((sdkRequests[1].body as { sessionKey?: string }).sessionKey).toBe(
      (sdkRequests[0].body as { sessionKey?: string }).sessionKey
    );
  });

  it("reuses the SDK session for standard Responses continuations", async () => {
    const db = new FakeD1();
    const env = { ...makeEnv(db), CURSOR_SDK_BRIDGE_URL: "https://bridge.test/sdk" };
    const { deps, sdkRequests } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);

    const first = await handleRequest(
      new Request("https://composer.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`
        },
        body: JSON.stringify({ model: "composer-2.5", input: "Say hello" })
      }),
      env,
      fakeCtx(),
      deps
    );
    const firstBody = (await first.json()) as { id: string };

    const second = await handleRequest(
      new Request("https://composer.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`
        },
        body: JSON.stringify({ model: "composer-2.5", previous_response_id: firstBody.id, input: "Say hello again" })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(second.status).toBe(200);
    await second.json();
    expect(sdkRequests).toHaveLength(2);
    expect((sdkRequests[1].body as { sessionKey?: string }).sessionKey).toBe((sdkRequests[0].body as { sessionKey?: string }).sessionKey);
  });

  it("stores Responses for retrieval and input item listing", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);

    const created = await handleRequest(
      new Request("https://composer.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`
        },
        body: JSON.stringify({ model: "composer-2.5", input: "Say hello" })
      }),
      env,
      fakeCtx(),
      deps
    );
    const createdBody = (await created.json()) as { id: string };

    const retrieved = await handleRequest(
      new Request(`https://composer.test/v1/responses/${createdBody.id}`, {
        headers: { Authorization: `Bearer ${relayKey}` }
      }),
      env,
      fakeCtx(),
      deps
    );
    await expect(retrieved.json()).resolves.toMatchObject({
      id: createdBody.id,
      object: "response",
      output: [{ type: "message", content: [{ type: "output_text", text: "Hello from Composer" }] }]
    });

    const inputItems = await handleRequest(
      new Request(`https://composer.test/v1/responses/${createdBody.id}/input_items`, {
        headers: { Authorization: `Bearer ${relayKey}` }
      }),
      env,
      fakeCtx(),
      deps
    );
    await expect(inputItems.json()).resolves.toMatchObject({
      object: "list",
      data: [{ id: "item_0", type: "message", role: "user" }],
      has_more: false
    });
  });

  it("continues Responses with previous_response_id context", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps, chatRequestBodies } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);

    const first = await handleRequest(
      new Request("https://composer.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`
        },
        body: JSON.stringify({ model: "composer-2.5", input: "Say hello" })
      }),
      env,
      fakeCtx(),
      deps
    );
    const firstBody = (await first.json()) as { id: string };

    const second = await handleRequest(
      new Request("https://composer.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`
        },
        body: JSON.stringify({ model: "composer-2.5", previous_response_id: firstBody.id, input: "Say hello" })
      }),
      env,
      fakeCtx(),
      deps
    );
    const secondBody = (await second.json()) as { previous_response_id: string };

    expect(second.status).toBe(200);
    expect(secondBody.previous_response_id).toBe(firstBody.id);
    expect(chatRequestBodies[1]).toContain("USER: Say hello");
    expect(chatRequestBodies[1]).toContain("ASSISTANT: Hello from Composer");
  });

  it("continues store false Responses without making them retrievable", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);

    const first = await handleRequest(
      new Request("https://composer.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`
        },
        body: JSON.stringify({ model: "composer-2.5", store: false, input: "Say hello" })
      }),
      env,
      fakeCtx(),
      deps
    );
    const firstBody = (await first.json()) as { id: string };

    const retrieved = await handleRequest(
      new Request(`https://composer.test/v1/responses/${firstBody.id}`, {
        headers: { Authorization: `Bearer ${relayKey}` }
      }),
      env,
      fakeCtx(),
      deps
    );
    expect(retrieved.status).toBe(404);

    const second = await handleRequest(
      new Request("https://composer.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`
        },
        body: JSON.stringify({ model: "composer-2.5", previous_response_id: firstBody.id, input: "Say hello" })
      }),
      env,
      fakeCtx(),
      deps
    );
    const secondBody = (await second.json()) as { previous_response_id: string };

    expect(second.status).toBe(200);
    expect(secondBody.previous_response_id).toBe(firstBody.id);
  });

  it("rejects missing or deleted previous Responses", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);

    const missing = await handleRequest(
      new Request("https://composer.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`
        },
        body: JSON.stringify({ model: "composer-2.5", previous_response_id: "resp_missing", input: "Say hello" })
      }),
      env,
      fakeCtx(),
      deps
    );
    expect(missing.status).toBe(404);

    const created = await handleRequest(
      new Request("https://composer.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`
        },
        body: JSON.stringify({ model: "composer-2.5", input: "Say hello" })
      }),
      env,
      fakeCtx(),
      deps
    );
    const createdBody = (await created.json()) as { id: string };

    const deleted = await handleRequest(
      new Request(`https://composer.test/v1/responses/${createdBody.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${relayKey}` }
      }),
      env,
      fakeCtx(),
      deps
    );
    await expect(deleted.json()).resolves.toMatchObject({ id: createdBody.id, deleted: true });

    const afterDelete = await handleRequest(
      new Request("https://composer.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`
        },
        body: JSON.stringify({ model: "composer-2.5", previous_response_id: createdBody.id, input: "Say hello" })
      }),
      env,
      fakeCtx(),
      deps
    );
    expect(afterDelete.status).toBe(404);
  });

  it("returns Responses function calls when tools are provided", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);

    const response = await handleRequest(
      new Request("https://composer.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`
        },
        body: JSON.stringify({
          model: "composer-2.5",
          input: "Schema transform",
          tools: [
            {
              type: "function",
              name: "glob",
              parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] }
            }
          ]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { object: string; output: Array<Record<string, unknown>> };
    expect(body.object).toBe("response");
    expect(body.output.find((item) => item.type === "function_call")).toMatchObject({
      type: "function_call",
      name: "glob",
      arguments: "{\"pattern\":\"**/*.ts\"}"
    });
  });

  it("uses the SDK bridge for standard Chat Completions when tools are provided", async () => {
    const db = new FakeD1();
    const env = { ...makeEnv(db), CURSOR_SDK_BRIDGE_URL: "https://bridge.test/sdk" };
    const { deps, chatRequestBodies, sdkRequests } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);

    const response = await handleRequest(
      new Request("https://composer.test/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Say hello" }],
          tools: [
            {
              type: "function",
              function: {
                name: "glob",
                parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] }
              }
            }
          ]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: "Hello from SDK" }, finish_reason: "stop" }]
    });
    expect(chatRequestBodies).toHaveLength(0);
    expect(sdkRequests.map((item) => `${item.method} ${item.path}`)).toEqual(["POST /sdk"]);
    expect((sdkRequests[0].body as { tools?: unknown[] }).tools).toEqual([
      {
        name: "glob",
        parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] }
      }
    ]);
  });

  it("streams Responses function_call events when tools are provided", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);

    const response = await handleRequest(
      new Request("https://composer.test/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`
        },
        body: JSON.stringify({
          model: "composer-2.5",
          stream: true,
          input: "Schema transform",
          tools: [
            {
              type: "function",
              name: "glob",
              parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] }
            }
          ]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("event: response.function_call_arguments.delta");
    expect(body).toContain("event: response.output_item.done");
    expect(body).toContain("\"name\":\"glob\"");
    expect(body).toContain("{\\\"pattern\\\":\\\"**/*.ts\\\"}");
  });

  it("streams SSE chat chunks with an sk- relay key", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();

    await adminAddCursorKey(env, deps, { makeDefault: true });
    const relayKey = await mintRelayKey(env, deps);

    const response = await handleRequest(
      new Request("https://composer.test/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`
        },
        body: JSON.stringify({
          model: "composer-2.5",
          stream: true,
          messages: [{ role: "user", content: "Say hello" }]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain('"object":"chat.completion.chunk"');
    expect(body).toContain('"content":"Hello from Composer"');
    expect(body).toContain("data: [DONE]");
  });

  it("streams Cursor errors as SSE errors instead of assistant text", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);

    const response = await handleRequest(
      new Request("https://composer.test/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`
        },
        body: JSON.stringify({
          model: "composer-2.5",
          stream: true,
          messages: [{ role: "user", content: "Trigger Cursor error" }]
        })
      }),
      env,
      fakeCtx(),
      deps
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("event: error");
    expect(body).toContain("Too many computers used within the last 24 hours");
    expect(body).not.toContain("[composer-api error]");
  });

  it("requires a bearer token for /v1/models", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);

    const noAuth = await handleRequest(
      new Request("https://composer.test/v1/models"),
      env,
      fakeCtx(),
      deps
    );
    expect(noAuth.status).toBe(401);

    const withAuth = await handleRequest(
      new Request("https://composer.test/v1/models", {
        headers: { Authorization: `Bearer ${relayKey}` }
      }),
      env,
      fakeCtx(),
      deps
    );
    expect(withAuth.status).toBe(200);
    const body = (await withAuth.json()) as { object: string; data: Array<{ id: string }> };
    expect(body).toMatchObject({
      object: "list",
      data: expect.arrayContaining([
        expect.objectContaining({ id: "composer-2.5" }),
        expect.objectContaining({ id: "composer-2.5-fast" }),
        expect.objectContaining({ id: "gpt-5.3-codex" }),
        expect.objectContaining({ id: "gemini-3.1-pro" }),
        expect.objectContaining({ id: "default" })
      ])
    });
    expect(body.data.map((model) => model.id)).toContain("claude-opus-5");
    expect(body.data.map((model) => model.id)).not.toContain("kimi-k2.5");
  });

  it("falls back to the static catalog when Cursor model listing fails", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);
    const originalFetch = deps.fetch;
    deps.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/models") return new Response("upstream down", { status: 503 });
      return originalFetch(input, init);
    };

    const response = await handleRequest(
      new Request("https://composer.test/v1/models", {
        headers: { Authorization: `Bearer ${relayKey}` }
      }),
      env,
      fakeCtx(),
      deps
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((model) => model.id)).toContain("kimi-k2.5");
  });

  it("returns 401 from /v1/models when Cursor rejects the key", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);
    const originalFetch = deps.fetch;
    deps.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/models") return new Response("unauthorized", { status: 401 });
      return originalFetch(input, init);
    };

    const response = await handleRequest(
      new Request("https://composer.test/v1/models", {
        headers: { Authorization: `Bearer ${relayKey}` }
      }),
      env,
      fakeCtx(),
      deps
    );
    expect(response.status).toBe(401);
  });

  it("rejects an unknown sk- relay token without forwarding it to Cursor", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps, exchangeAuthHeaders } = fakeDeps();

    const completion = await handleRequest(
      new Request("https://composer.test/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer sk-not-a-real-relay-key"
        },
        body: JSON.stringify({ model: "composer-2.5", messages: [{ role: "user", content: "Hi" }] })
      }),
      env,
      fakeCtx(),
      deps
    );
    expect(completion.status).toBe(401);
    // An unresolved sk- token fails closed and is never forwarded to Cursor.
    expect(exchangeAuthHeaders).toHaveLength(0);
  });

  it("returns 400 for malformed JSON body instead of 500", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();
    const relayKey = await seedRelayKey(env, deps);

    const response = await handleRequest(
      new Request("https://composer.test/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey}`
        },
        body: "{ invalid json }"
      }),
      env,
      fakeCtx(),
      deps
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request_error");
  });
});

describe("app config and access logs", () => {
  it("writes a 64-char hex ENCRYPTION_KEY on first request when env is empty", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    delete env.ENCRYPTION_KEY;
    const { deps } = fakeDeps();

    const response = await handleRequest(
      new Request("https://composer.test/api/console/session"),
      env,
      fakeCtx(),
      deps
    );
    expect(response.status).toBe(200);
    const stored = db.appSettings.get("encryption_key")?.value ?? "";
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
  });

  it("imports ENCRYPTION_KEY from env once and does not rotate it", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();
    const original = env.ENCRYPTION_KEY;

    await handleRequest(new Request("https://composer.test/api/console/session"), env, fakeCtx(), deps);
    expect(db.appSettings.get("encryption_key")?.value).toBe(original);

    env.ENCRYPTION_KEY = "a-different-secret-that-must-not-replace";
    await handleRequest(new Request("https://composer.test/api/console/session"), env, fakeCtx(), deps);
    expect(db.appSettings.get("encryption_key")?.value).toBe(original);
  });

  it("records /v1 and /api/admin access logs", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const { deps } = fakeDeps();
    const ctx = fakeCtx();

    const unauthorized = await handleRequest(
      new Request("https://composer.test/v1/models", {
        headers: { Authorization: "Bearer sk-missing" }
      }),
      env,
      ctx,
      deps
    );
    expect(unauthorized.status).toBe(401);

    const admin = await handleRequest(
      new Request("https://composer.test/api/admin/cursor-keys"),
      env,
      ctx,
      deps
    );
    expect(admin.status).toBe(200);
    await ctx.drain();

    const paths = [...db.accessLogs.values()].map((row) => row.path).sort();
    expect(paths).toEqual(["/api/admin/cursor-keys", "/v1/models"]);
  });

  it("lists access logs and updates listen settings", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const listenCalls: string[] = [];
    const { deps } = fakeDeps({
      fetch: async (input, init) => {
        const url = new URL(String(input));
        listenCalls.push(`${init?.method || "GET"} ${url.pathname}`);
        if (url.pathname === "/health") {
          return Response.json({ ok: true, agents: 0, host: "127.0.0.1", port: 8792, url: "http://127.0.0.1:8792/sdk" });
        }
        if (url.pathname === "/listen" || url.pathname === "/__station/rebind") {
          return Response.json({ ok: true, newOrigin: "http://127.0.0.1:5174" });
        }
        return new Response("not found", { status: 404 });
      }
    });

    await handleRequest(new Request("https://composer.test/api/admin/cursor-keys"), env, fakeCtx(), deps);
    const ctx = fakeCtx();
    await handleRequest(new Request("https://composer.test/api/admin/cursor-keys"), env, ctx, deps);
    await ctx.drain();

    const listed = await handleRequest(
      new Request("https://composer.test/api/admin/access-logs?limit=10&offset=0"),
      env,
      fakeCtx(),
      deps
    );
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { logs: Array<{ path: string }>; total: number };
    expect(listedBody.total).toBeGreaterThanOrEqual(2);
    expect(listedBody.logs.some((row) => row.path === "/api/admin/cursor-keys")).toBe(true);

    const filtered = await handleRequest(
      new Request("https://composer.test/api/admin/access-logs?q=cursor-keys"),
      env,
      fakeCtx(),
      deps
    );
    expect(filtered.status).toBe(200);
    const filteredBody = (await filtered.json()) as { logs: Array<{ path: string }>; total: number };
    expect(filteredBody.total).toBeGreaterThanOrEqual(1);
    expect(filteredBody.logs.every((row) => row.path.includes("cursor-keys"))).toBe(true);

    const runtime = await handleRequest(
      new Request("https://composer.test/api/admin/runtime"),
      env,
      fakeCtx(),
      deps
    );
    expect(runtime.status).toBe(200);
    const runtimeBody = (await runtime.json()) as {
      encryptionKey: { present: boolean };
      sdk: { host: string; port: number; probe: { status: string } };
    };
    expect(runtimeBody.encryptionKey.present).toBe(true);
    expect(runtimeBody.sdk.host).toBe("127.0.0.1");
    expect(runtimeBody.sdk.port).toBe(8792);

    const saved = await handleRequest(
      new Request("https://composer.test/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sdkListenHost: "127.0.0.1", sdkListenPort: 8793, relayListenHost: "0.0.0.0", relayListenPort: 5174 })
      }),
      env,
      fakeCtx(),
      deps
    );
    expect(saved.status).toBe(200);
    const savedBody = (await saved.json()) as {
      sdk: { port: number; rebind: { ok: boolean } };
      relay: { port: number; rebind: { ok: boolean; newOrigin?: string } };
    };
    expect(savedBody.sdk.port).toBe(8793);
    expect(savedBody.relay.port).toBe(5174);
    expect(savedBody.sdk.rebind.ok).toBe(true);
    expect(savedBody.relay.rebind.ok).toBe(true);
    expect(savedBody.relay.rebind.newOrigin).toBe("http://127.0.0.1:5174");
    expect(listenCalls.some((entry) => entry === "POST /listen")).toBe(true);
    expect(listenCalls.some((entry) => entry === "POST /__station/rebind")).toBe(true);
    expect(db.appSettings.get("sdk_listen_port")?.value).toBe("8793");
  });
});

function fakeDeps(overrides: Partial<Deps> = {}): {
  deps: Deps;
  exchangeAuthHeaders: string[];
  chatAuthHeaders: string[];
  chatRequestHeaders: Headers[];
  chatRequestBodies: string[];
  sdkRequests: Array<{ method: string; path: string; headers: Headers; body: unknown }>;
} {
  const exchangeAuthHeaders: string[] = [];
  const chatAuthHeaders: string[] = [];
  const chatRequestHeaders: Headers[] = [];
  const chatRequestBodies: string[] = [];
  const sdkRequests: Array<{ method: string; path: string; headers: Headers; body: unknown }> = [];
  let uuidCounter = 0;
  const deps: Deps = {
    now: () => new Date("2026-05-20T12:00:00.000Z"),
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const auth = new Headers(init?.headers).get("authorization") || "";
      if (url.pathname === "/v1/me") {
        return Response.json({
          apiKeyName: "Test key",
          userId: 123,
          userEmail: "ada@example.com",
          userFirstName: "Ada",
          userLastName: "Lovelace",
          createdAt: "2026-05-20T00:00:00.000Z"
        });
      }
      if (url.pathname === "/v1/models") {
        return Response.json({
          items: [
            { id: "default", displayName: "Auto", aliases: ["auto"] },
            { id: "composer-2.5", displayName: "Composer 2.5" },
            { id: "composer-2.5-fast", displayName: "Composer 2.5 Fast" },
            { id: "gpt-5.3-codex", displayName: "Codex 5.3" },
            { id: "gemini-3.1-pro", displayName: "Gemini 3.1 Pro" },
            { id: "grok-4.6", displayName: "Cursor Grok 4.6" },
            { id: "grok-4.6-fast", displayName: "Cursor Grok 4.6 Fast" },
            { id: "claude-opus-5", displayName: "Claude Opus 5" }
          ]
        });
      }
      if (url.pathname === "/auth/exchange_user_api_key" && init?.method === "POST") {
        exchangeAuthHeaders.push(auth);
        return Response.json({ accessToken: "cursor_access_token" });
      }
      if (url.pathname === "/test-local-sdk" && init?.method === "POST") {
        const headers = new Headers(init.headers);
        const body = await decodeRequestBody(init.body);
        sdkRequests.push({ method: "POST", path: url.pathname, headers, body });
        return localSdkFakeResponse(sdkRunKind(body));
      }
      if (url.hostname === "bridge.test" && url.pathname === "/sdk" && init?.method === "POST") {
        const headers = new Headers(init.headers);
        const body = JSON.parse(String(init.body || "{}")) as Record<string, unknown>;
        sdkRequests.push({ method: "POST", path: url.pathname, headers, body });
        return localSdkBridgeJsonResponse(sdkRunKind(typeof body.prompt === "string" ? body.prompt : ""));
      }
      if (url.pathname === "/test-cursor-chat" && init?.method === "POST") {
        const headers = new Headers(init.headers);
        chatAuthHeaders.push(auth);
        chatRequestHeaders.push(headers);
        expect(headers.get("content-type")).toContain("application/connect+proto");
        const requestText = await decodeRequestBody(init.body);
        chatRequestBodies.push(requestText);
        if (requestText.includes("Trigger Cursor error")) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(connectFrame(cursorError("Too many computers.", "Too many computers used within the last 24 hours."), 2));
                controller.close();
              }
            }),
            { headers: { "Content-Type": "application/connect+proto" } }
          );
        }
        if (requestText.includes("Schema transform")) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  connectFrame(
                    chatResponseText(
                      [
                        "Checking the workspace.\n",
                        "<|tool_calls_begin|><|tool_call_begin|>\n",
                        "Glob\n",
                        "<|tool_sep|>targeting\n",
                        "/Users/example/project/**\n",
                        "<|tool_sep|>glob_pattern\n",
                        "*.ts\n",
                        "<|tool_call_end|><|tool_calls_end|>"
                      ].join("")
                    )
                  )
                );
                controller.enqueue(connectFrame(new TextEncoder().encode("{}"), 2));
                controller.close();
              }
            }),
            { headers: { "Content-Type": "application/connect+proto" } }
          );
        }
        if (requestText.includes("List files")) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  connectFrame(
                    chatResponseText(
                      [
                        "Checking the workspace.\n",
                        "<|tool_calls_begin|><|tool_call_begin|>\n",
                        "Glob\n",
                        "<|tool_sep|>glob_pattern\n",
                        "*\n",
                        "<|tool_call_end|><|tool_calls_end|>"
                      ].join("")
                    )
                  )
                );
                controller.enqueue(connectFrame(new TextEncoder().encode("{}"), 2));
                controller.close();
              }
            }),
            { headers: { "Content-Type": "application/connect+proto" } }
          );
        }
        expect(requestText).toContain("Say hello");
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(connectFrame(chatResponseThinking("The answer is simple.</think>\nHello from Composer")));
              controller.enqueue(connectFrame(new TextEncoder().encode("{}"), 2));
              controller.close();
            }
          }),
          { headers: { "Content-Type": "application/connect+proto" } }
        );
      }
      return new Response("not found", { status: 404 });
    }
  };
  Object.assign(deps, overrides);
  return { deps, exchangeAuthHeaders, chatAuthHeaders, chatRequestHeaders, chatRequestBodies, sdkRequests };
}

function cursorError(title: string, detail: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      error: {
        code: "resource_exhausted",
        message: "Error",
        details: [{ debug: { details: { title, detail } } }]
      }
    })
  );
}

async function decodeRequestBody(body: BodyInit | null | undefined): Promise<string> {
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (typeof body === "string") return body;
  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
        if (chunks.length >= 1) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    return new TextDecoder().decode(concatTestBytes(chunks));
  }
  return "";
}

function sdkRunKind(body: string): "completed" | "drop" | "hello" | "invalid" | "list" | "shell" | "tool-result" {
  const text = body;
  if (text.includes("Completed SDK tool result")) return "completed";
  if (text.includes("LOCAL OPENCODE TOOL RESULT:")) return "tool-result";
  if (text.includes("Retry invalid mapped tool") && text.includes("TOOL CALL RETRY")) return "drop";
  if (text.includes("Retry invalid mapped tool")) return "invalid";
  if (text.includes("Retry dropped stream")) return "drop";
  if (text.includes("Run shell command")) return "shell";
  if (text.includes("List files")) return "list";
  return "hello";
}

function localSdkFakeResponse(kind: ReturnType<typeof sdkRunKind>): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (kind === "list") {
          controller.enqueue(localSdkToolCallFrame("sdk_call_1", 4, protoMessage([protoField(2, "*")])));
        } else if (kind === "invalid") {
          controller.enqueue(
            localSdkToolCallFrame(
              "sdk_call_invalid",
              15,
              protoMessage([
                protoField(1, "create_issue"),
                protoField(2, protoValueMapEntry("body", protoStringValue("Missing required title"))),
                protoField(4, "github"),
                protoField(5, "create_issue")
              ])
            )
          );
        } else if (kind === "drop") {
          controller.enqueue(localSdkTextFrame("Partial after retry"));
        } else if (kind === "shell") {
          controller.enqueue(localSdkExecFrame(1, 2, protoMessage([protoField(1, "npm test"), protoField(2, "/workspace")])));
        } else if (kind === "completed") {
          const readArgs = protoMessage([protoField(1, "README.md")]);
          const readCall = protoMessage([protoField(1, readArgs), protoField(2, protoMessage([]))]);
          controller.enqueue(localSdkToolCallCompletedFrame("sdk_call_completed", 8, readCall));
          controller.enqueue(localSdkTextFrame("Done after cloud result"));
        } else if (kind === "tool-result") {
          controller.enqueue(localSdkTextFrame("Tool result incorporated"));
        } else {
          controller.enqueue(localSdkTextFrame("Hello from SDK"));
        }
        controller.enqueue(localSdkTurnEndedFrame());
        controller.enqueue(connectFrame(new TextEncoder().encode("{}"), 2));
        controller.close();
      }
    }),
    { headers: { "Content-Type": "application/connect+proto" } }
  );
}

function localSdkBridgeJsonResponse(kind: ReturnType<typeof sdkRunKind>): Response {
  if (kind === "list") {
    return Response.json({ text: "", toolCalls: [{ name: "glob", arguments: { globPattern: "*" } }], agentID: "agent-test", runID: "run-test" });
  }
  if (kind === "invalid") {
    return Response.json({
      text: "",
      toolCalls: [
        {
          name: "mcp",
          arguments: {
            name: "create_issue",
            providerIdentifier: "github",
            toolName: "create_issue",
            args: { body: "Missing required title" }
          }
        }
      ],
      agentID: "agent-test",
      runID: "run-test"
    });
  }
  if (kind === "drop") {
    return Response.json({ text: "Partial after retry", toolCalls: [], agentID: "agent-test", runID: "run-test" });
  }
  if (kind === "shell") {
    return Response.json({
      text: "",
      toolCalls: [{ name: "shell", arguments: { command: "npm test", workingDirectory: "/workspace" } }],
      agentID: "agent-test",
      runID: "run-test"
    });
  }
  if (kind === "completed") {
    return Response.json({
      text: "Done after cloud result",
      toolCalls: [{ name: "read", arguments: { path: "README.md" } }],
      agentID: "agent-test",
      runID: "run-test"
    });
  }
  if (kind === "tool-result") {
    return Response.json({ text: "Tool result incorporated", toolCalls: [], agentID: "agent-test", runID: "run-test" });
  }
  return Response.json({ text: "Hello from SDK", toolCalls: [], agentID: "agent-test", runID: "run-test" });
}

function decodeBase64ForTest(value: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(value), (char) => char.charCodeAt(0)));
}

function concatTestBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function sseFrame(event: string, data: unknown, id?: string): Uint8Array {
  return new TextEncoder().encode(`${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function chatResponseThinking(text: string): Uint8Array {
  return protoMessage([protoField(2, protoMessage([protoField(25, protoMessage([protoField(1, text)]))]))]);
}

function chatResponseText(text: string): Uint8Array {
  return protoMessage([protoField(2, protoMessage([protoField(1, text)]))]);
}

function localSdkTextFrame(text: string): Uint8Array {
  const textDelta = protoMessage([protoField(1, text)]);
  const interaction = protoMessage([protoField(1, textDelta)]);
  return connectFrame(protoMessage([protoField(1, interaction)]));
}

function localSdkTurnEndedFrame(): Uint8Array {
  const interaction = protoMessage([protoField(14, protoMessage([]))]);
  return connectFrame(protoMessage([protoField(1, interaction)]));
}

function localSdkToolCallFrame(callId: string, toolField: number, args: Uint8Array): Uint8Array {
  const toolPayload = protoMessage([protoField(1, args)]);
  const toolCall = protoMessage([protoField(toolField, toolPayload)]);
  const started = protoMessage([protoField(1, callId), protoField(2, toolCall)]);
  const interaction = protoMessage([protoField(2, started)]);
  return connectFrame(protoMessage([protoField(1, interaction)]));
}

function localSdkToolCallCompletedFrame(callId: string, toolField: number, toolCallPayload: Uint8Array): Uint8Array {
  const toolCall = protoMessage([protoField(toolField, toolCallPayload)]);
  const completed = protoMessage([protoField(1, callId), protoField(2, toolCall)]);
  const interaction = protoMessage([protoField(3, completed)]);
  return connectFrame(protoMessage([protoField(1, interaction)]));
}

function localSdkExecFrame(execId: number, execField: number, args: Uint8Array): Uint8Array {
  const exec = protoMessage([protoVarintField(1, execId), protoField(execField, args)]);
  return connectFrame(protoMessage([protoField(2, exec)]));
}

function connectFrame(payload: Uint8Array, flags = 0): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = flags;
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

function protoMessage(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function protoField(fieldNumber: number, value: string | Uint8Array): Uint8Array {
  const data = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return protoMessage([varint((fieldNumber << 3) | 2), varint(data.length), data]);
}

function protoValueMapEntry(key: string, value: Uint8Array): Uint8Array {
  return protoMessage([protoField(1, key), protoField(2, value)]);
}

function protoStringValue(value: string): Uint8Array {
  return protoMessage([protoField(3, value)]);
}

function protoVarintField(fieldNumber: number, value: number): Uint8Array {
  return protoMessage([varint(fieldNumber << 3), varint(value)]);
}

function varint(value: number): Uint8Array {
  const bytes: number[] = [];
  let current = value;
  while (current >= 0x80) {
    bytes.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }
  bytes.push(current);
  return new Uint8Array(bytes);
}
