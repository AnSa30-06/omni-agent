// The free-provider catalogue, checked against the code that consumes it.
//
// Both of these caught real bugs before release. They are cheap and they guard
// the two ways this catalogue can be wrong without anything crashing.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { catalogue, setupSteps, renderSetup } from "../../src/setup/providers.mjs";
import { pkg } from "../../src/util/paths.mjs";
import { DEFAULTS } from "../../src/config.mjs";

test("search keys are stored under the names the search code actually reads", () => {
  // The catalogue once used brave.apiKey / tavily.apiKey / serper.apiKey while
  // search.mjs resolved search.brave / search.tavily / search.serper. Adding a
  // key appeared to work and then did nothing at all.
  const src = fs.readFileSync(pkg("src", "tools", "search.mjs"), "utf8") +
    fs.readFileSync(pkg("src", "tools", "web.mjs"), "utf8");
  for (const s of catalogue().search) {
    assert.ok(
      src.includes(`"${s.secret}"`),
      `${s.id} stores its key as "${s.secret}", which nothing in search.mjs or web.mjs resolves`
    );
    assert.ok(src.includes(`"${s.env}"`), `${s.id} names env var ${s.env}, which nothing reads`);
  }
});

test("every keyless provider named in the catalogue is really in the default chain", () => {
  const order = DEFAULTS.search.order;
  for (const k of catalogue().keyless ?? []) {
    assert.ok(order.includes(k.id), `${k.id} is described to the user but is not in the default search order`);
  }
});

test("every provider that needs a credential has setup instructions", () => {
  for (const s of catalogue().search) {
    const st = setupSteps(s.id);
    assert.equal(st.ok, true, `${s.id} has no setup entry`);
    assert.ok(st.steps.length >= 2, `${s.id} has ${st.steps.length} step(s)`);
    // The last actionable step must be the command that actually stores it.
    assert.ok(
      st.steps.some((x) => x.includes(`provider add ${s.id}`)),
      `${s.id} never tells the user the command to run`
    );
  }
});

test("setup instructions render with sequential numbering", () => {
  const out = renderSetup(setupSteps("searxng"));
  const nums = [...out.matchAll(/^ {2}(\d+)\./gm)].map((m) => Number(m[1]));
  assert.deepEqual(nums, nums.map((_, i) => i + 1), "continuation lines must not consume a step number");
});

test("a signup link is present for anything that needs an account", () => {
  for (const s of catalogue().search) {
    assert.match(s.signup ?? "", /^https:\/\//, `${s.id} has no signup URL`);
  }
});

test("a key is proved with a real call, because the gateway says a bad one is fine", () => {
  // 🔴 The bug this exists for. Measured 2026-09-02: a deliberately invalid
  // OpenRouter key ("sk-or-v1-000...0") was reported by the gateway's own
  // /api/providers/{id}/test as {"valid":true,"diagnosis":{"type":"ok"}}, and
  // adding it put 1032 models into the picker that all answer 401. The app said
  // "OpenRouter connected" and every model failed - which is exactly what gets
  // reported as "I added my key and it didn't work".
  const prov = fs.readFileSync(pkg("src", "setup", "providers.mjs"), "utf8");
  assert.match(prov, /export async function verifyModelProvider/);
  // A DIRECT call: complete() would fall back to another provider and report a
  // broken key as working - the one way this check could fool itself.
  assert.match(prov, /client\.chat\(\{/, "the probe calls one model directly");
  assert.ok(!/verifyModelProvider[\s\S]{0,900}complete\(/.test(prov), "the probe must not use the fallback chain");
  // Three outcomes, never collapsed into two.
  assert.match(prov, /status === 401 \|\| status === 403[\s\S]*?state: "rejected"/);
  assert.match(prov, /status === 402[\s\S]*?no credit left/);
  assert.match(prov, /state: "ok", model/);

  const api = fs.readFileSync(pkg("src", "ui", "api.mjs"), "utf8");
  const add = api.slice(api.indexOf("async providerAdd"), api.indexOf("async providerSignin"));
  // A refused key must leave NOTHING behind, or its models stay in the picker.
  assert.match(add, /if \(v\.state === "rejected"\)[\s\S]*?removeConnection/);
  assert.match(add, /works: false,\s*\n\s*newModels: 0,/);
  // works is a tri-state: null means "could not tell", not "failed".
  assert.match(add, /works: v\.state === "ok" \? true : null,/);
  // The before/after diff must come from the GATEWAY, not OpenCode's 5-minute
  // cache - a stale diff was empty, so there was nothing to probe.
  assert.match(add, /const before = await gatewayIds\(\)/);
  assert.match(add, /startsWith\(alias \+ "\/"\)/, "only this provider's own models are probed");
});

test("a connection that is wrong or out of credit can be removed from the app", () => {
  // providerRemove existed as a route with no caller, so a bad key could only
  // be cleaned up from the gateway's own dashboard. And a connection the
  // curated list does not name - measured: a `deepseek` one with no credit -
  // was not shown at all while still feeding models into the picker.
  const prov = fs.readFileSync(pkg("src", "setup", "providers.mjs"), "utf8");
  assert.match(prov, /connectionId: connectionOf\.get\(p\.id\) \?\? null/, "the page is told which connection to remove");
  assert.match(prov, /const others = \(conn\.connections \?\? \[\]\)[\s\S]*?!curated\.has\(c\.provider\)/);
  const app = fs.readFileSync(pkg("src", "ui", "public", "app.js"), "utf8");
  assert.match(app, /api\("providerRemove", \{ method: "POST", body: \{ connectionId: p\.connectionId \} \}\)/);
  assert.match(app, /section\("Also connected"\)/);
});
