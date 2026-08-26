import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT = path.join(REPO_ROOT, "scripts", "cursor-sdk-local-agent-bridge.mjs");
const LISTEN_FILE = path.join(REPO_ROOT, ".wrangler", "station-listen.json");
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 5173;
const DEFAULT_SDK_HOST = "127.0.0.1";
const DEFAULT_SDK_PORT = 8792;

interface StationListen {
  relayHost: string;
  relayPort: number;
  sdkHost: string;
  sdkPort: number;
}

const stationListen = loadStationListen();
persistStationListen(stationListen);

/**
 * Starts the Cursor SDK local-agent bridge alongside `vite dev` so a single
 * `npm run dev` process serves the web app and the bridge. Set
 * `SDK_BRIDGE_AUTOSTART=0` to opt out (e.g. when running the bridge yourself).
 */
function sdkBridgePlugin(): Plugin {
  let child: ChildProcess | null = null;

  const stop = (): void => {
    if (child && !child.killed) child.kill();
    child = null;
  };

  return {
    name: "sdk-bridge-autostart",
    apply: "serve",
    configureServer(server) {
      if (process.env.SDK_BRIDGE_AUTOSTART === "0" || child) return;
      child = spawn(process.execPath, [BRIDGE_SCRIPT], {
        stdio: "inherit",
        env: {
          ...process.env,
          CURSOR_SDK_BRIDGE_HOST: process.env.CURSOR_SDK_BRIDGE_HOST || stationListen.sdkHost,
          CURSOR_SDK_BRIDGE_PORT: process.env.CURSOR_SDK_BRIDGE_PORT || String(stationListen.sdkPort)
        }
      });
      child.on("exit", (code) => {
        if (code) server.config.logger.warn(`[sdk-bridge] exited with code ${code}`);
        child = null;
      });
      server.httpServer?.once("close", stop);
      process.once("exit", stop);
      process.once("SIGINT", () => {
        stop();
        process.exit(0);
      });
      process.once("SIGTERM", () => {
        stop();
        process.exit(0);
      });
    }
  };
}

/**
 * Dev-only live rebind for the Vite HTTP server. Must not live under `/api/*`
 * because those paths are handled by the Worker (`run_worker_first`).
 */
function stationRebindPlugin(): Plugin {
  return {
    name: "station-rebind",
    apply: "serve",
    configureServer(server) {
      const handler = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
        const path = (req.url ?? "").split("?")[0];
        if (req.method === "OPTIONS" && path === "/__station/rebind") {
          res.writeHead(204, {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "POST,OPTIONS",
            "access-control-allow-headers": "content-type"
          });
          res.end();
          return;
        }
        if (req.method !== "POST" || path !== "/__station/rebind") {
          next();
          return;
        }
        void handleStationRebind(server, req, res);
      };
      server.middlewares.use(handler);
      return () => {
        const stack = server.middlewares.stack;
        const index = stack.findIndex((layer) => layer.handle === handler);
        if (index > 0) {
          const [layer] = stack.splice(index, 1);
          if (layer) stack.unshift(layer);
        }
      };
    }
  };
}

async function handleStationRebind(
  server: ViteDevServer,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  try {
    const body = await readJsonBody(req);
    const host = String(body.host ?? "").trim();
    const port = Number(body.port);
    if (!host) {
      writeViteJson(res, { ok: false, error: "Host is required" }, 400);
      return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      writeViteJson(res, { ok: false, error: "Port must be an integer between 1 and 65535" }, 400);
      return;
    }

    const httpServer = server.httpServer as import("node:http").Server | null;
    const current = httpServer?.address();
    const currentPort = current && typeof current === "object" ? current.port : undefined;
    const currentHost = current && typeof current === "object" ? current.address : undefined;
    const requestHost = (req.headers.host || `127.0.0.1:${currentPort ?? DEFAULT_PORT}`).split(":")[0];
    const publicHost = host === "0.0.0.0" || host === "::" ? requestHost : host;
    const newOrigin = `http://${publicHost}:${port}`;

    writeViteJson(res, { ok: true, host, port, newOrigin });
    persistStationListen({ relayHost: host, relayPort: port });
    if (sameListenTarget(currentHost, currentPort, host, port)) return;

    setImmediate(() => {
      if (!httpServer) {
        server.config.logger.warn("[station] rebind skipped: HTTP server not ready");
        return;
      }
      rebindHttpServer(httpServer, host, port, server.config.logger, newOrigin);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON";
    writeViteJson(res, { ok: false, error: message }, 400);
  }
}

function sameListenTarget(
  currentHost: string | undefined,
  currentPort: number | undefined,
  host: string,
  port: number
): boolean {
  if (currentPort !== port) return false;
  if (!currentHost) return false;
  const normalize = (value: string): string =>
    value === "::" || value === "0.0.0.0" || value === "::ffff:0.0.0.0" ? "0.0.0.0" : value.replace(/^::ffff:/, "");
  return normalize(currentHost) === normalize(host);
}

function rebindHttpServer(
  httpServer: import("node:http").Server,
  host: string,
  port: number,
  logger: { warn: (msg: string) => void; info: (msg: string) => void },
  newOrigin: string
): void {
  if (typeof httpServer.closeAllConnections === "function") {
    httpServer.closeAllConnections();
  }
  let started = false;
  const listen = (): void => {
    if (started) return;
    started = true;
    const onError = (listenError: Error) => {
      httpServer.off("error", onError);
      logger.warn(`[station] rebind listen failed: ${listenError.message}`);
    };
    httpServer.once("error", onError);
    httpServer.listen(port, host, () => {
      httpServer.off("error", onError);
      logger.info(`[station] listening on ${newOrigin}`);
    });
  };
  const fallback = setTimeout(listen, 400);
  httpServer.close((error) => {
    clearTimeout(fallback);
    if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
      logger.warn(`[station] rebind close failed: ${error.message}`);
    }
    listen();
  });
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (chunks.reduce((sum, part) => sum + part.length, 0) > 64 * 1024) {
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function writeViteJson(res: ServerResponse, body: unknown, status = 200): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(data.length)
  });
  res.end(data);
}

function loadStationListen(): StationListen {
  const defaults: StationListen = {
    relayHost: DEFAULT_HOST,
    relayPort: DEFAULT_PORT,
    sdkHost: DEFAULT_SDK_HOST,
    sdkPort: DEFAULT_SDK_PORT
  };
  return { ...defaults, ...readListenFile(), ...readListenFromD1() };
}

function persistStationListen(patch: Partial<StationListen>): void {
  const next = { ...loadStationListen(), ...patch };
  mkdirSync(path.dirname(LISTEN_FILE), { recursive: true });
  writeFileSync(LISTEN_FILE, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function readListenFile(): Partial<StationListen> {
  try {
    const raw = JSON.parse(readFileSync(LISTEN_FILE, "utf8")) as Record<string, unknown>;
    return parseListenRecord(raw);
  } catch {
    return {};
  }
}

function readListenFromD1(): Partial<StationListen> {
  const dir = path.join(REPO_ROOT, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite");
  } catch {
    return {};
  }
  for (const file of files) {
    try {
      const db = new DatabaseSync(path.join(dir, file), { readOnly: true });
      try {
        const rows = db
          .prepare(
            "SELECT key, value FROM app_settings WHERE key IN ('relay_listen_host','relay_listen_port','sdk_listen_host','sdk_listen_port')"
          )
          .all() as Array<{ key: string; value: string }>;
        if (!rows.length) continue;
        return parseListenRecord({
          relayHost: rows.find((row) => row.key === "relay_listen_host")?.value,
          relayPort: rows.find((row) => row.key === "relay_listen_port")?.value,
          sdkHost: rows.find((row) => row.key === "sdk_listen_host")?.value,
          sdkPort: rows.find((row) => row.key === "sdk_listen_port")?.value
        });
      } finally {
        db.close();
      }
    } catch {
      /* missing table or locked db */
    }
  }
  return {};
}

function parseListenRecord(raw: Record<string, unknown>): Partial<StationListen> {
  const next: Partial<StationListen> = {};
  const relayHost = asHost(raw.relayHost ?? raw.relayListenHost);
  const sdkHost = asHost(raw.sdkHost ?? raw.sdkListenHost);
  const relayPort = asPort(raw.relayPort ?? raw.relayListenPort);
  const sdkPort = asPort(raw.sdkPort ?? raw.sdkListenPort);
  if (relayHost) next.relayHost = relayHost;
  if (sdkHost) next.sdkHost = sdkHost;
  if (relayPort) next.relayPort = relayPort;
  if (sdkPort) next.sdkPort = sdkPort;
  return next;
}

function asHost(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const host = value.trim();
  if (/\s/.test(host) || host.includes("/")) return undefined;
  return host;
}

function asPort(value: unknown): number | undefined {
  const port = typeof value === "number" ? value : Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

export default defineConfig({
  plugins: [stationRebindPlugin(), sdkBridgePlugin(), cloudflare()],
  server: {
    host: stationListen.relayHost,
    port: stationListen.relayPort,
    strictPort: stationListen.relayPort !== DEFAULT_PORT,
    watch: {
      ignored: ["**/macos/**"]
    }
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]"
      }
    }
  }
});
