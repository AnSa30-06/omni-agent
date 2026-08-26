// Build OmniAgent-Portable-<version>.zip.
//
// The fallback and debugging distribution: same application, no installer, no
// registry entries, no shortcuts. Unzip and run start.bat. It still bundles the
// Node runtime, so it works on a machine with nothing preinstalled.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { APP_ROOT } from "../src/util/paths.mjs";

const say = (s = "") => process.stdout.write(s + "\n");
const VERSION = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "package.json"), "utf8")).version;
const STAGING = path.join(APP_ROOT, "staging");
const DIST = path.join(APP_ROOT, "dist");
const OUT = path.join(DIST, `OmniAgent-Portable-${VERSION}.zip`);

function main() {
  if (!fs.existsSync(path.join(STAGING, "app")) || !fs.existsSync(path.join(STAGING, "node"))) {
    say("staging/ is empty. Run `npm run build:installer` first - it stages the app and the Node runtime.");
    process.exit(1);
  }

  // Copy the portable entry points into the staging root so the zip is usable
  // the moment it is extracted.
  for (const f of ["start.bat", "setup.bat", "install.ps1", "install.bat"]) {
    const src = path.join(APP_ROOT, "installer", "portable", f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(STAGING, f));
  }
  fs.copyFileSync(path.join(APP_ROOT, "README.md"), path.join(STAGING, "README.md"));
  fs.copyFileSync(path.join(APP_ROOT, "LICENSE"), path.join(STAGING, "LICENSE"));

  fs.mkdirSync(DIST, { recursive: true });
  fs.rmSync(OUT, { force: true });

  say(`Compressing ${STAGING} ...`);
  const r = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Compress-Archive -Path '${STAGING}\\*' -DestinationPath '${OUT}' -CompressionLevel Optimal -Force`,
    ],
    { stdio: "inherit", windowsHide: true }
  );
  if (r.status !== 0 || !fs.existsSync(OUT)) {
    say("Compress-Archive failed.");
    process.exit(1);
  }

  const mb = (fs.statSync(OUT).size / 1048576).toFixed(1);
  const sha = createHash("sha256").update(fs.readFileSync(OUT)).digest("hex");
  say("");
  say(`Built: ${OUT}  (${mb} MB)`);
  say(`SHA256: ${sha}`);
}

main();
