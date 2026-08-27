const { app, BrowserWindow, dialog, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const DEFAULT_PORT = 5173;
const START_TIMEOUT_MS = 90_000;

let mainWindow = null;
let serverProcess = null;
let stopping = false;
let stationLog = null;

function userDataPath(...parts) {
  return path.join(app.getPath("userData"), ...parts);
}

function repoRoot() {
  return path.join(__dirname, "..");
}

function packedStationRoot() {
  return path.join(process.resourcesPath, "station");
}

function resolveNodeBin() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "node", "node.exe");
  }
  const portable = path.join(repoRoot(), "tools", "node-win-x64", "node.exe");
  if (fs.existsSync(portable)) return portable;
  if (path.basename(process.execPath).toLowerCase().startsWith("electron")) {
    return "node";
  }
  return process.execPath;
}

function canWrite(dir) {
  const probe = path.join(dir, `.write-${process.pid}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function ensureJunction(linkPath, target) {
  fs.mkdirSync(target, { recursive: true });
  try {
    const st = fs.lstatSync(linkPath);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      fs.cpSync(linkPath, target, { recursive: true, force: false });
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
  } catch {
    /* missing */
  }
  if (!fs.existsSync(linkPath)) {
    fs.symlinkSync(target, linkPath, "junction");
  }
}

function syncRuntime(from, to) {
  const persist = path.join(to, ".wrangler");
  const backup = userDataPath("wrangler-hold");
  if (fs.existsSync(persist)) {
    fs.rmSync(backup, { recursive: true, force: true });
    fs.cpSync(persist, backup, { recursive: true });
  }
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
  if (fs.existsSync(backup)) {
    fs.cpSync(backup, path.join(to, ".wrangler"), { recursive: true });
    fs.rmSync(backup, { recursive: true, force: true });
  }
}

function resolveStationRoot() {
  if (!app.isPackaged) return repoRoot();

  const packed = packedStationRoot();
  const persistDir = userDataPath("wrangler");
  if (canWrite(packed)) {
    ensureJunction(path.join(packed, ".wrangler"), persistDir);
    return packed;
  }

  const runtime = userDataPath("runtime");
  const stamp = path.join(runtime, ".bundle-version");
  const version = app.getVersion();
  const needSync = !fs.existsSync(stamp) || fs.readFileSync(stamp, "utf8").trim() !== version;
  if (needSync) {
    syncRuntime(packed, runtime);
    fs.writeFileSync(stamp, version);
  }
  return runtime;
}

function readListen(stationRoot) {
  const file = path.join(stationRoot, ".wrangler", "station-listen.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const port = Number(raw.relayPort ?? raw.relayListenPort);
    const host = String(raw.relayHost ?? raw.relayListenHost ?? "").trim();
    return {
      host: host || "127.0.0.1",
      port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_PORT
    };
  } catch {
    return { host: "127.0.0.1", port: DEFAULT_PORT };
  }
}

function browserHost(host) {
  if (!host || host === "0.0.0.0" || host === "::" || host === "[::]") return "127.0.0.1";
  return host;
}

function childEnv(stationRoot, nodeBin) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ASAR;
  env.CI = "1";
  env.WRANGLER_SEND_METRICS = "false";
  const extra = [path.join(stationRoot, "node_modules", ".bin")];
  if (nodeBin !== "node") extra.push(path.dirname(nodeBin));
  env.PATH = `${extra.join(path.delimiter)}${path.delimiter}${env.PATH || ""}`;
  return env;
}

function appendLog(chunk) {
  if (!stationLog) return;
  stationLog.write(chunk);
}

function killTree(pid) {
  if (!pid) return;
  spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore"
  });
}

function stopServer() {
  if (!serverProcess) return;
  const pid = serverProcess.pid;
  serverProcess = null;
  killTree(pid);
}

function wranglerMigrationFinished(text) {
  if (/No migrations to apply/i.test(text)) return true;
  const last = text.slice(-4000);
  return /commands executed successfully/i.test(last) && /✅/.test(last) && !/🕒️/.test(last);
}

function runProcess(command, args, opts, timeoutMs, isComplete) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...opts,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    let output = "";
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const succeed = () => {
      killTree(child.pid);
      finish();
    };
    const onChunk = (chunk) => {
      const text = chunk.toString("utf8");
      output += text;
      appendLog(chunk);
      if (isComplete?.(output)) succeed();
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      onChunk(chunk);
    });
    const timer = setTimeout(() => {
      killTree(child.pid);
      finish(new Error("命令超时"));
    }, timeoutMs);
    child.on("error", (err) => finish(err));
    child.on("exit", (code) => {
      if (settled) return;
      if (code === 0 || isComplete?.(output)) finish();
      else finish(new Error(stderr.trim() || `退出码 ${code}`));
    });
  });
}

async function applyMigrations(nodeBin, stationRoot, env) {
  const wrangler = path.join(stationRoot, "node_modules", "wrangler", "bin", "wrangler.js");
  if (!fs.existsSync(wrangler)) return;
  await runProcess(
    nodeBin,
    [wrangler, "d1", "migrations", "apply", "composer-api", "--local"],
    { cwd: stationRoot, env },
    45_000,
    wranglerMigrationFinished
  );
}

function startVite(nodeBin, stationRoot, env) {
  const vite = path.join(stationRoot, "node_modules", "vite", "bin", "vite.js");
  if (!fs.existsSync(vite)) {
    throw new Error("未找到 Vite，请重新打包或先执行 npm install。");
  }
  serverProcess = spawn(nodeBin, [vite], {
    cwd: stationRoot,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  serverProcess.stdout?.on("data", appendLog);
  serverProcess.stderr?.on("data", appendLog);
  serverProcess.on("exit", (code) => {
    if (!stopping && code) {
      dialog.showErrorBox("中转服务已退出", `Vite 进程退出码 ${code}。详情见 ${userDataPath("station.log")}`);
    }
  });
}

function waitForHttp(origin, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const ping = () => {
      const req = http.get(`${origin}/`, { timeout: 1500 }, (res) => {
        res.resume();
        resolve(origin);
      });
      req.on("timeout", () => req.destroy());
      req.on("error", () => {
        if (Date.now() - started > timeoutMs) {
          reject(new Error("服务启动超时。请查看用户目录下的 station.log。"));
          return;
        }
        setTimeout(ping, 400);
      });
    };
    ping();
  });
}

function setStatus(text) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const payload = JSON.stringify(text);
  mainWindow.webContents.executeJavaScript(
    `var el = document.getElementById("status"); if (el) el.textContent = ${payload};`
  ).catch(() => {});
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#06131a",
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.loadFile(path.join(__dirname, "loading.html"));
  mainWindow.focus();
  if (process.env.STATION_DEBUG === "1") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

async function startStation() {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  stationLog = fs.createWriteStream(userDataPath("station.log"), { flags: "a" });
  stationLog.write(`\n--- ${new Date().toISOString()} ---\n`);

  setStatus("正在准备运行时…");
  const stationRoot = resolveStationRoot();
  const nodeBin = resolveNodeBin();
  if (nodeBin !== "node" && !fs.existsSync(nodeBin)) {
    throw new Error("未找到便携 Node 运行时。请重新执行 npm run dist:win。");
  }

  const env = childEnv(stationRoot, nodeBin);
  setStatus("正在应用本地数据库迁移…");
  try {
    await applyMigrations(nodeBin, stationRoot, env);
  } catch (err) {
    appendLog(String(err?.stack || err));
  }

  const listen = readListen(stationRoot);
  setStatus(`正在启动中转（端口 ${listen.port}）…`);
  startVite(nodeBin, stationRoot, env);

  const origin = `http://${browserHost(listen.host)}:${listen.port}`;
  await waitForHttp(origin, START_TIMEOUT_MS);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  await mainWindow.loadURL(`${origin}/`);
  mainWindow.show();
  mainWindow.focus();
}

function showStartError(err) {
  const message = err instanceof Error ? err.message : String(err);
  appendLog(`\n[fatal] ${message}\n${err instanceof Error ? err.stack : ""}\n`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    setStatus(message);
    mainWindow.show();
    mainWindow.focus();
  }
  dialog.showErrorBox("无法启动 API for Cursor", `${message}\n\n日志：${userDataPath("station.log")}`);
}

process.on("uncaughtException", (err) => {
  try {
    fs.appendFileSync(userDataPath("station.log"), `\n[uncaught] ${err.stack || err}\n`);
  } catch {
    /* ignore */
  }
  dialog.showErrorBox("API for Cursor 崩溃", String(err?.stack || err));
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    createWindow();
    try {
      await startStation();
    } catch (err) {
      showStartError(err);
    }
  });

  app.on("before-quit", () => {
    stopping = true;
    stopServer();
    stationLog?.end();
  });

  app.on("window-all-closed", () => {
    stopping = true;
    stopServer();
    app.quit();
  });
}
