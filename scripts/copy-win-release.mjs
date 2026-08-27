import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const { version, productName } = (() => {
  const pkg = createRequire(import.meta.url)("../package.json");
  return { version: pkg.version, productName: "API for Cursor" };
})();

const DIST = path.join(ROOT, "dist-win");
const DEST = path.join(DIST, `v${version}`);

const names = [
  `${productName}-${version}-setup.exe`,
  `${productName}-${version}-win.zip`,
  "latest.yml"
];

mkdirSync(DEST, { recursive: true });

for (const name of names) {
  const src = path.join(DIST, name);
  if (!existsSync(src)) {
    console.warn("skip missing artifact:", name);
    continue;
  }
  copyFileSync(src, path.join(DEST, name));
  console.log("copied", name, "->", `dist-win/v${version}/`);
}

const extras = readdirSync(DIST).filter(
  (name) =>
    name.startsWith(`${productName}-${version}`) &&
    !names.includes(name) &&
    (name.endsWith(".exe") || name.endsWith(".zip") || name.endsWith(".blockmap"))
);

for (const name of extras) {
  copyFileSync(path.join(DIST, name), path.join(DEST, name));
  console.log("copied", name, "->", `dist-win/v${version}/`);
}
