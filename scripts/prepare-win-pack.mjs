import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEST = path.join(ROOT, "pack", "win-runtime");
const DEPS = path.join(ROOT, "pack", "win-deps");
const NODE_DIR = path.join(ROOT, "tools", "node-win-x64");

const SKIP_TOP_MODULES = new Set([
  "electron",
  "electron-builder",
  "electron-builder-squirrel-windows",
  "app-builder-bin",
  "app-builder-lib",
  "app-builder-util",
  "dmg-builder",
  "electron-publish",
  "electron-rebuild",
  "electron-winstaller",
  "@electron",
  "7zip-bin",
  ".vite",
  ".cache",
  ".bin"
]);

function nodeVersion() {
  const current = process.versions.node;
  return current.startsWith("22.") ? current : "22.18.0";
}

function shouldSkipNative(top) {
  if (!top) return false;
  const name = top.toLowerCase();
  if (name.includes("win32") || name.includes("windows")) return false;
  return (
    name.includes("darwin") ||
    name.includes("linux") ||
    name.includes("android") ||
    name.includes("freebsd") ||
    name.includes("musl")
  );
}

async function ensurePortableNode() {
  const exe = path.join(NODE_DIR, "node.exe");
  if (existsSync(exe)) {
    console.log("portable node: reuse", exe);
    return;
  }

  const version = nodeVersion();
  const zipName = `node-v${version}-win-x64.zip`;
  const cacheDir = path.join(ROOT, "tools", "cache");
  const zipPath = path.join(cacheDir, zipName);
  mkdirSync(cacheDir, { recursive: true });

  if (!existsSync(zipPath)) {
    const url = `https://nodejs.org/dist/v${version}/${zipName}`;
    console.log("downloading", url);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`下载 Node 失败：${response.status} ${url}`);
    }
    writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));
  }

  const extracted = path.join(cacheDir, `node-v${version}-win-x64`);
  rmSync(extracted, { recursive: true, force: true });
  const unpacked = spawnSync("tar", ["-xf", zipPath, "-C", cacheDir], { stdio: "inherit" });
  if (unpacked.status !== 0) {
    throw new Error("解压 Node zip 失败，请确认系统自带 tar。");
  }
  const extractedExe = path.join(extracted, "node.exe");
  if (!existsSync(extractedExe)) {
    throw new Error(`未找到 ${extractedExe}`);
  }
  mkdirSync(NODE_DIR, { recursive: true });
  cpSync(extractedExe, exe);
  console.log("portable node: wrote", exe);
}

function copyRuntime() {
  rmSync(DEST, { recursive: true, force: true });
  mkdirSync(DEST, { recursive: true });

  const files = ["index.html", "package.json", "wrangler.jsonc", "vite.config.ts", "tsconfig.json"];
  for (const file of files) {
    cpSync(path.join(ROOT, file), path.join(DEST, file));
  }

  const dirs = ["src", "worker", "scripts", "migrations", "public"];
  for (const dir of dirs) {
    const from = path.join(ROOT, dir);
    if (!existsSync(from)) continue;
    cpSync(from, path.join(DEST, dir), {
      recursive: true,
      filter: (src) => {
        const base = path.basename(src);
        if (base.endsWith(".test.ts") || base.endsWith(".test.mjs") || base.endsWith(".sh")) {
          return false;
        }
        if (base === "prepare-win-pack.mjs") return false;
        return true;
      }
    });
  }

  const modulesFrom = path.join(ROOT, "node_modules");
  if (!existsSync(modulesFrom)) {
    throw new Error("缺少 node_modules，请先执行 npm install。");
  }
  rmSync(DEPS, { recursive: true, force: true });
  mkdirSync(DEPS, { recursive: true });
  const modulesRoot = modulesFrom + path.sep;
  cpSync(modulesFrom, DEPS, {
    recursive: true,
    filter: (src) => {
      if (src === modulesFrom) return true;
      const rel = src.startsWith(modulesRoot) ? src.slice(modulesRoot.length) : "";
      const parts = rel.split(/[/\\]/).filter(Boolean);
      const top = parts[0] || "";
      const pkg = top.startsWith("@") && parts[1] ? `${top}/${parts[1]}` : top;
      if (SKIP_TOP_MODULES.has(top)) return false;
      if (shouldSkipNative(pkg)) return false;
      return true;
    }
  });

  console.log("staged runtime at", DEST);
  console.log("staged deps at", DEPS);
}

await ensurePortableNode();
copyRuntime();
