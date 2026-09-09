// The auto-updater, which copies files into a live 3.4 GB install.
//
// Everything here guards the same thing: an update that goes wrong must leave
// the app exactly as it was. A broken install is worse than an old one,
// because the reader has no way back and no idea what happened.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareVersions, structuralReasons, applyUpdate } from "../../src/update/updater.mjs";
import { pkg } from "../../src/util/paths.mjs";

test("versions sort numerically, not as text", () => {
  // "1.1.9" > "1.1.13" as strings, which would offer an update that goes
  // BACKWARDS and then keep offering it forever.
  assert.equal(compareVersions("1.1.9", "1.1.13"), -1);
  assert.equal(compareVersions("1.2.0", "1.2.0"), 0);
  assert.equal(compareVersions("v1.3", "1.2.9"), 1);
  assert.equal(compareVersions("1.2.0", "1.10.0"), -1);
  assert.equal(compareVersions(null, "1.0.0"), -1);
});

test("a release that changes the SHAPE of the install is refused", () => {
  // 🔴 The case this was written against, and it was real, not imagined: while
  // this feature was being built, HEAD of this repository renamed the product
  // from omni-agent to vireo, moved its data directory and added a `zod`
  // dependency across 90 files. Copying those files into an install would have
  // deleted the program the shortcuts point at, pointed the app at an empty
  // data folder, and imported a package that is not on disk.
  const oldPkg = { name: "omni-agent", bin: { "omni-agent": "bin/omni-agent.mjs" }, dependencies: { a: "1" } };

  const renamed = structuralReasons(oldPkg, { ...oldPkg, name: "vireo" }, []);
  assert.equal(renamed.length, 1);
  assert.match(renamed[0], /renamed/);

  const moved = structuralReasons(oldPkg, { ...oldPkg, bin: { vireo: "bin/vireo.mjs" } }, []);
  assert.match(moved[0], /starts the app/);

  const deps = structuralReasons(oldPkg, { ...oldPkg, dependencies: { a: "1", zod: "^4" } }, []);
  assert.match(deps[0], /supporting packages/);

  // The gateway's packages are installed on disk; copying its manifest over the
  // top would leave the manifest and the packages disagreeing.
  const gw = structuralReasons(oldPkg, oldPkg, [{ filename: "runtime/package.json" }]);
  assert.match(gw[0], /gateway/);

  // An ordinary release changes none of these.
  assert.deepEqual(structuralReasons(oldPkg, { ...oldPkg, version: "9.9.9" }, [{ filename: "src/ui/api.mjs" }]), []);
});

test("a blocked plan is never applied, whatever else it says", async () => {
  // The block has to hold at the point of ACTION too, not only in the plan.
  // planUpdate and applyUpdate are separate calls, and anything can happen
  // between them - including a caller that ignores the flag.
  const res = await applyUpdate({ ok: true, blocked: true, reasons: ["it was renamed"], files: [] });
  assert.equal(res.ok, false);
  assert.equal(res.needsInstaller, true);
  assert.match(res.reason, /renamed/);
});

test("a file that does not match what GitHub published is never written", async () => {
  // 🔴 The only integrity check available without signing anything: the compare
  // API reports git's own object id for each file, and that id is recomputable
  // from the bytes. Verified live 2026-09-09 against src/ui/api.mjs at v1.2.0.
  // A download that fails it is either damaged or not the published file, and
  // neither belongs in a working install.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omni-upd-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-home-"));
  const victim = path.join(root, "src", "ui");
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, "api.mjs"), "ORIGINAL");

  const res = await applyUpdate(
    {
      ok: true,
      current: "1.1.13",
      target: "1.2.0",
      files: [
        {
          filename: "src/ui/api.mjs",
          status: "modified",
          sha: "0".repeat(40), // cannot match anything
          raw_url: "https://raw.githubusercontent.com/AnSa30-06/omni-agent/v1.2.0/src/ui/api.mjs",
        },
      ],
    },
    { root, home },
  );
  assert.equal(res.ok, false);
  assert.match(res.reason, /did not arrive intact/);
  // And the point of the whole exercise: the install is untouched.
  assert.equal(fs.readFileSync(path.join(victim, "api.mjs"), "utf8"), "ORIGINAL");
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test("only files that exist inside an install are ever copied", () => {
  // A whitelist, not a blacklist. A new top-level directory must not be shipped
  // into an install just because nobody remembered to exclude it. `tests/` and
  // `.github/` are not in an install at all; `installer/` is, but is only ever
  // read by the build.
  const src = fs.readFileSync(pkg("src", "update", "updater.mjs"), "utf8");
  assert.match(src, /const SHIPPED = \["src\/", "config\/", "plugin\/", "skills\/", "bin\/", "scripts\/"\];/);
  assert.ok(!/tests\//.test(src.slice(src.indexOf("const SHIPPED ="), src.indexOf("function isShipped"))));

  // Releases, never commits. A commit on main is work in progress - the rename
  // that broke this was committed and unreleased at the time.
  assert.match(src, /\/releases\/latest/);
  assert.ok(!/\/commits\/|\/heads\/main/.test(src), "the updater must not follow a branch");
});

test("the update is announced, never applied on its own", () => {
  // ⚠️ Updating restarts the app. A restart that arrives unasked destroys
  // whatever the reader was in the middle of, so the daily check may only put a
  // bar on screen - the button is the reader's.
  const app = fs.readFileSync(pkg("src", "ui", "public", "app.js"), "utf8");
  const fn = app.slice(app.indexOf("async function checkForUpdate("), app.indexOf("async function applyUpdate("));
  assert.ok(fn.length > 100, "the check exists");
  assert.ok(!/updateApply/.test(fn), "checking must never apply");
  assert.match(app, /setInterval\(\(\) => checkForUpdate\(\)\.catch\(\(\) => \{\}\), 24 \* 60 \* 60 \* 1000\);/);
  assert.match(app, /\$\("btn-update"\)\.onclick = \(\) => applyUpdate\(\);/);
  // A release that cannot be copied must not offer a button that would refuse.
  assert.match(app, /r\.blocked[\s\S]{0,120}needs the full installer/);
  // Dismissing one version must not silence the next one.
  assert.match(app, /if \(state\.updateDismissed === r\.latest\) return;/);
  // Never restart on top of a running turn.
  assert.match(app, /if \(state\.busy\) return toast\("Wait for the current answer to finish", "bad"\);/);

  const api = fs.readFileSync(pkg("src", "ui", "api.mjs"), "utf8");
  const route = api.slice(api.indexOf("async updateApply("), api.indexOf("async folderCheck("));
  // The answer has to reach the page before the process goes, or the reader
  // sees a dropped connection and cannot tell success from failure.
  assert.match(route, /setTimeout\(\(\) => \{\s*\n\s*up\.restartApp\(\)/);
  assert.match(route, /return ok\(\{ applied: true/);
});
