// The wiring between the Decisions page and its server.
//
// A typo in a route name is a 404 that the page renders as an empty section,
// which is easy to mistake for "there is nothing to show". This is the same
// check tests/unit/ui.test.mjs makes for the chat app, applied to the second
// surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.VIREO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "omni-routes-test-"));

const { pkg } = await import("../../src/util/paths.mjs");
const { decisionRoutes } = await import("../../src/decisions/routes.mjs");
const { routes } = await import("../../src/ui/api.mjs");

const read = (...p) => fs.readFileSync(pkg(...p), "utf8");

test("every route the page calls exists on the server", () => {
  const js = read("src", "ui", "public", "decisions", "decisions.js");
  const called = new Set([...js.matchAll(/\bapi\(\s*"([a-zA-Z]+)"/g)].map((m) => m[1]));
  assert.ok(called.size > 15, `expected the page to call many routes, saw ${called.size}`);
  for (const name of called) {
    assert.ok(Object.hasOwn(decisionRoutes, name), `decisions.js calls /x/${name}, which src/decisions/routes.mjs does not define`);
  }
});

test("the decisions routes do not collide with the chat app's routes", () => {
  const clash = Object.keys(decisionRoutes).filter((k) => Object.hasOwn(routes, k));
  assert.deepEqual(clash, [], `these route names are defined twice: ${clash.join(", ")}`);
});

test("every decisions route name is namespaced, so a future collision is unlikely", () => {
  for (const name of Object.keys(decisionRoutes)) {
    assert.match(name, /^decisions[A-Z]/, `${name} should start with "decisions"`);
  }
});

test("the server merges both tables into its dispatcher", () => {
  const server = read("src", "ui", "server.mjs");
  assert.match(server, /decisionRoutes/, "server.mjs must import the decisions route table");
  assert.match(server, /ALL_ROUTES\[name\]/, "the dispatcher must look up the merged table");
  assert.ok(!/const fn = routes\[name\]/.test(server), "the dispatcher must not still read the chat table alone");
});

test("a directory URL serves its index, so /decisions/ is reachable", () => {
  const server = read("src", "ui", "server.mjs");
  assert.match(server, /endsWith\("\/"\)/, "serveStatic must map a trailing slash to index.html");
  assert.ok(fs.existsSync(pkg("src", "ui", "public", "decisions", "index.html")));
});

test("the page is reachable from the chat app and from the CLI", () => {
  assert.match(read("src", "ui", "public", "index.html"), /data-page="decisions"/);
  assert.match(read("src", "ui", "public", "app.js"), /pages\.decisions/);
  assert.match(read("bin", "vireo.mjs"), /case "decisions"/);
});

test("nothing in the Decisions page writes model output as HTML", () => {
  // Comments are stripped first: the file explains this rule in prose at the
  // top, and the first version of this test failed on its own documentation.
  const code = read("src", "ui", "public", "decisions", "decisions.js")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  for (const bad of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
    assert.ok(!code.includes(bad), `${bad} must never appear: imported names and model text are untrusted`);
  }
});

test("the two model tasks are declared, so routing is not left to a default", async () => {
  const md = JSON.parse(read("config", "models", "metadata.json"));
  assert.equal(md.tasks["decision-brief"], "smart");
  assert.equal(md.tasks["decision-draft"], "fast");
});

test("the rules file is valid and every situation names real signals and actions", async () => {
  const { rules, validate } = await import("../../src/decisions/rules.mjs");
  assert.doesNotThrow(() => validate(rules()));
});

test("a malformed rules file fails loudly, naming the key", async () => {
  const { validate } = await import("../../src/decisions/rules.mjs");
  const good = JSON.parse(read("config", "decisions", "rules.json"));
  const broken = structuredClone(good);
  delete broken.signals.usage_drop_30d.bands;
  assert.throws(() => validate(broken), /signals\.usage_drop_30d\.bands/);

  const badAction = structuredClone(good);
  badAction.situations.churn_risk.actions = ["not_a_real_action"];
  assert.throws(() => validate(badAction), /not_a_real_action/);
});
