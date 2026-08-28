// The on-disk preferences, and the one field that stops a fresh install's
// first message failing.
//
// Set before anything imports paths.mjs, which resolves the home directory once
// at module load - so this file must do its imports dynamically, below.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-prefs-"));
process.env.OMNI_AGENT_HOME = home;
const { readPrefs, writePrefs, rememberVerifiedModel, prefsFile } = await import("../../src/ui/prefs.mjs");

test("preferences survive a round trip, and a missing file is not an error", () => {
  // The UI server takes a fresh port every launch, so the page is a new browser
  // origin each time and nothing can be kept in browser storage.
  assert.deepEqual(readPrefs(), { kinds: {} }, "no file yet must read as empty, not throw");
  assert.ok(writePrefs({ kinds: {}, model: { providerID: "p", id: "oc/x" } }));
  assert.equal(readPrefs().model.id, "oc/x");
  assert.ok(prefsFile().startsWith(home), "must be written under the app's own home, not the repo");
});

test("the verified model is recorded without touching the chosen one", () => {
  // 🔴 The bug this exists for: on a clean keyless install the gateway's
  // configured default is an auto/ combo, which resolved to a gated model and
  // the very first message died on
  //   [401] Model north-mini-code-free is not supported
  // Setup already sends a real request and already falls back until something
  // answers, so the model that answered is a MEASURED fact about this machine.
  writePrefs({ kinds: {}, model: { providerID: "p", id: "chosen/by-the-user" } });
  assert.ok(rememberVerifiedModel("oc/hy3-free"));
  const p = readPrefs();
  assert.equal(p.verifiedModel, "oc/hy3-free");
  assert.equal(p.model.id, "chosen/by-the-user", "setup re-running must never change a chosen model");
});

test("nothing is recorded when setup got no answer at all", () => {
  // runDoctor returns servedModel: null when the deep check was skipped or every
  // model refused. Writing that would seed the app with "undefined" and send the
  // first message to a model id that does not exist.
  writePrefs({ kinds: {} });
  assert.equal(rememberVerifiedModel(null), false);
  assert.equal(rememberVerifiedModel(""), false);
  assert.equal(rememberVerifiedModel(undefined), false);
  assert.ok(!Object.hasOwn(readPrefs(), "verifiedModel"));
});
