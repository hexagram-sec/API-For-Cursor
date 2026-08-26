const fs = require("node:fs");
const path = require("node:path");

/** Ensures Vite/Wrangler deps land in resources/station/node_modules. */
exports.default = async function afterPack(context) {
  const station = path.join(context.appOutDir, "resources", "station");
  const dest = path.join(station, "node_modules");
  const vite = path.join(dest, "vite", "bin", "vite.js");
  if (fs.existsSync(vite)) return;

  const from = path.join(context.packager.projectDir, "pack", "win-deps");
  if (!fs.existsSync(from)) {
    throw new Error(`afterPack: missing ${from}`);
  }
  fs.mkdirSync(station, { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(from, dest, { recursive: true });
  if (!fs.existsSync(vite)) {
    throw new Error("afterPack: Vite was not copied into the Windows app.");
  }
};
