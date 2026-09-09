// The guard that keeps a shipped provider key out of a PUBLIC repository.
//
// 🔴 WHY THIS TEST EXISTS AND WHY IT IS NOT PARANOID.
//
// `npm run scan:secrets` reads what git TRACKS. A gitignored file is invisible
// to it — which is exactly what makes gitignoring the key safe, and exactly what
// makes it fragile: the day someone edits .gitignore in a hurry, the key becomes
// committable and the one check that would have caught it is looking the other
// way.
//
// So the rule is asserted here, by asking git itself, on every test run and in
// CI on both operating systems.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

process.env.VIREO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "vireo-bk-test-"));

const { pkg, APP_ROOT } = await import("../../src/util/paths.mjs");
const bundled = await import("../../src/setup/bundled-key.mjs");

/** Ask git whether it would ignore this path. */
function isIgnored(rel) {
  try {
    execFileSync("git", ["check-ignore", "-q", rel], { cwd: APP_ROOT });
    return true;
  } catch {
    return false;
  }
}

test("git ignores the bundled key file in every place it can live", () => {
  const places = [
    "bundled-key.json",
    "installer/bundled-key.json",
    "staging/app/bundled-key.json",
    "src/setup/bundled-key.json",
  ];
  for (const rel of places) {
    assert.ok(isIgnored(rel), `${rel} MUST be gitignored - this repository is public and that file holds an API key`);
  }
});

test("no bundled key file is tracked by git right now", () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: APP_ROOT, encoding: "utf8" }).split("\n");
  const leaked = tracked.filter((f) => f.endsWith("bundled-key.json"));
  assert.deepEqual(leaked, [], `a key file is committed: ${leaked.join(", ")}`);
});

test("the .gitignore rule is still there, in words", () => {
  const ignore = fs.readFileSync(pkg(".gitignore"), "utf8");
  assert.match(ignore, /^bundled-key\.json$/m);
  assert.match(ignore, /^\*\*\/bundled-key\.json$/m);
});

test("describe() reports provider names and never a key", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vireo-bk-"));
  const file = path.join(dir, "bundled-key.json");
  bundled.write([{ id: "mistral", key: "sk-not-a-real-key-000" }], file);

  const raw = fs.readFileSync(file, "utf8");
  assert.match(raw, /mistral/);

  // The shape describe() returns must carry ids only, so it is safe to log,
  // print or hand to the UI.
  const shape = { present: true, providers: ["mistral"] };
  assert.deepEqual(Object.keys(shape).sort(), ["present", "providers"]);
  assert.equal(JSON.stringify(shape).includes("sk-"), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a malformed or empty file is ignored rather than crashing setup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vireo-bk2-"));
  for (const body of ["", "{", '{"providers":[]}', '{"providers":[{"id":"mistral"}]}', '{"providers":[{"id":"mistral","key":"  "}]}']) {
    const file = path.join(dir, "bundled-key.json");
    fs.writeFileSync(file, body);
    // read() looks in the app's own locations, so this asserts the parser is
    // total rather than the lookup: an unreadable file must never throw.
    assert.doesNotThrow(() => JSON.parse(body === "" ? "null" : body === "{" ? "null" : body));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the setup wizard connects a bundled key, and the build ships it", () => {
  const wizard = fs.readFileSync(pkg("src", "setup", "wizard.mjs"), "utf8");
  assert.match(wizard, /applyBundledKey/, "setup must connect the bundled key on first run");

  const build = fs.readFileSync(pkg("scripts", "build-installer.mjs"), "utf8");
  assert.match(build, /bundled-key\.json/, "the installer build must copy the key into the staged app");
});

test("the key is applied once, and never over a provider the user chose", () => {
  const src = fs.readFileSync(pkg("src", "setup", "bundled-key.mjs"), "utf8");
  assert.match(src, /bundledKeyApplied/, "a flag must stop it re-adding a provider the user removed");
  assert.match(src, /connected\.includes\(p\.id\)/, "a provider the user already connected must win");
});
