// The free-provider catalogue, checked against the code that consumes it.
//
// Both of these caught real bugs before release. They are cheap and they guard
// the two ways this catalogue can be wrong without anything crashing.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { catalogue, setupSteps, renderSetup, keylessHealth } from "../../src/setup/providers.mjs";
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

test("in the app, the instructions point at the box on the page, not a terminal", () => {
  // The "How?" button showed the CLI steps verbatim, so someone who has never
  // opened a terminal was told to `Run: omni-agent provider add openrouter
  // YOUR-KEY` directly above a box that already takes the key. That is the
  // "I didn't know how to add it" half of the complaint.
  for (const id of ["openrouter", "mistral", "cerebras"]) {
    const inApp = setupSteps(id, { context: "app" });
    assert.ok(inApp.ok, `${id} should have instructions`);
    const joined = inApp.steps.join(" | ");
    assert.ok(!/omni-agent provider add/.test(joined), `${id}: the app must not tell the reader to run a CLI command`);
    assert.match(joined, /Paste the key into the box on this page/);
    assert.ok(!/omni-agent models/.test(String(inApp.verify)), "the check is what the app does for you");

    // The terminal wording is untouched for people actually in a terminal.
    const cli = setupSteps(id);
    assert.match(cli.steps.join(" | "), /Run:\s+omni-agent provider add/);
  }
  // A sign-in provider gets the button that is actually on screen.
  const signin = setupSteps("claude", { context: "app" });
  assert.match(signin.steps.join(" | "), /Press Sign in on this page/);
});

test("a key is proved by a completion, never by a public model list", () => {
  // 🔴 The trap this guards, caught by testing a FAKE key against my own fix:
  // `GET {base}/models` looks like an auth check and is served PUBLICLY by
  // OpenRouter, so sk-or-v1- + 48 zeros came back 200 "ok". A check that passes
  // a garbage key is worse than no check - it is the exact defect 1.1.6 removed.
  // The listing may only choose a model; the proof must be a completion.
  const prov = fs.readFileSync(pkg("src", "setup", "providers.mjs"), "utf8");
  const fn = prov.slice(prov.indexOf("async function askProviderDirectly"), prov.indexOf("export async function verifyModelProvider"));
  assert.ok(fn.length > 200, "askProviderDirectly exists");
  assert.match(fn, /\/chat\/completions`/, "the evidence is a completion");
  assert.match(fn, /max_tokens: 1/, "and a cheap one");
  // The model list must never on its own return ok.
  // Anchored on the numbered step, not on prose that gets reworded - the last
  // version of this test silently sliced past the completion step when the
  // comment changed, and stopped checking anything.
  const iList = fn.indexOf("`${root}/models`");
  const iProof = fn.indexOf("// 2. Proof of life");
  assert.ok(iList > 0 && iProof > iList, "the listing step comes before the proof step");
  const listPart = fn.slice(iList, iProof);
  assert.ok(!/return "ok"/.test(listPart), 'the model list must never conclude "ok" by itself');
  // 401/403 from the listing may still condemn a key (some providers gate it).
  assert.match(listPart, /r\.status === 401 \|\| r\.status === 403\) return "rejected"/);
  // Verified live 2026-09-02: real key -> ok, fake key -> rejected.
});

test("adding a provider re-syncs the agent, or the models never show up", () => {
  // Measured 2026-09-02: the gateway held 995 new models while the picker still
  // offered the 119 it had cached before the key was added, because OpenCode
  // learns models from the OmniRoute plugin only when that plugin BOOTS - its
  // five-minute auto-sync does not notice a new provider. An app left running
  // 21 minutes after the add still showed the old list.
  const oc = fs.readFileSync(pkg("src", "ui", "opencode-server.mjs"), "utf8");
  assert.match(oc, /export async function restart\(/);
  // stop() only asks; start() returns {reused:true} while _state is still set,
  // so a restart that does not wait is a silent no-op.
  assert.match(oc, /for \(let i = 0; i < 100 && _state; i\+\+\)/, "restart waits for the process to actually go");

  const api = fs.readFileSync(pkg("src", "ui", "api.mjs"), "utf8");
  assert.match(api, /if \(agentRunning\(\)\) \{\s*\n\s*const r = await restartAgent\(\);/);
  assert.match(api, /agentRestarted: rewire\.agentRestarted === true/);

  const app = fs.readFileSync(pkg("src", "ui", "public", "app.js"), "utf8");
  assert.ok((app.match(/await loadModels\(\);/g) ?? []).length >= 3, "the picker reloads after add and after remove");
});

test("every key provider is checked with the header it actually wants", () => {
  // Measured 2026-09-02 against all 13 key providers with a deliberately fake
  // key: most take `Authorization: Bearer`, zai takes x-api-key and gemini
  // x-goog-api-key. Sending the wrong one turns a GOOD key into a 401, which is
  // a false accusation and the worst answer this check can give.
  const prov = fs.readFileSync(pkg("src", "setup", "providers.mjs"), "utf8");
  assert.match(prov, /function authHeaders\(entry, apiKey\)/);
  assert.match(prov, /entry\?\.auth\?\.header \?\? "bearer"/, "the header comes from the manifest, not an assumption");
  assert.match(prov, /\[declared\]: apiKey/, "a named header is used verbatim");
  assert.match(prov, /const H = authHeaders\(entry, apiKey\);/);
});

test("the measured dead keyless vendors are named, dated and explained", () => {
  // 🔴 The complaint, verbatim: "all the other models in the free list, auggie,
  // the old llm, felo, all are fucked, why even write them if they're screwed".
  // Measured 2026-09-03 with one real completion per model, 5 models per vendor,
  // 25 s apart: of 9 keyless vendors, 8 answered nothing at all. 71 of the 77
  // keyless models cannot reply. Only `oc` works.
  const doc = JSON.parse(fs.readFileSync(pkg("config", "providers", "keyless-health.json"), "utf8"));
  assert.match(doc.measured ?? "", /^\d{4}-\d{2}-\d{2}$/, "the file must carry the date it was measured");
  const byVendor = new Map(doc.broken.map((b) => [b.vendor, b]));
  for (const v of ["aug", "tllm", "felo"]) {
    assert.ok(byVendor.has(v), `${v} was measured dead and must be listed`);
  }
  for (const b of doc.broken) {
    // The reason is shown to the reader in the picker, so it has to read as
    // plain English rather than as a status code.
    assert.ok(b.reason && b.reason.length > 8, `${b.vendor} has no readable reason`);
    assert.ok(!/^HTTP|^\d{3}\b/.test(b.reason), `${b.vendor}'s reason is a status code, not an explanation`);
    // The code goes in `evidence`, which is for the record and not for the UI.
    assert.ok(b.evidence, `${b.vendor} has no evidence recorded`);
  }
  // A vendor cannot be both dead and working.
  const working = new Set((doc.working ?? []).map((w) => w.vendor));
  for (const v of working) assert.ok(!byVendor.has(v), `${v} is listed as both working and broken`);

  // And the loader has to actually read it.
  const loaded = keylessHealth();
  assert.equal(loaded.get("tllm")?.reason, byVendor.get("tllm").reason);
  assert.equal(loaded.get("oc"), undefined, "a working vendor must not be marked broken");
});

test("dead keyless vendors are hidden from the picker and never retried onto", () => {
  // Two halves, and the second is the one that wasted the reader's turns: the
  // retry ladder walked straight onto felo, tllm and mcode in a row, because
  // the gateway's own ordering has nothing to do with whether a model answers.
  const api = fs.readFileSync(pkg("src", "ui", "api.mjs"), "utf8");
  assert.match(api, /const brokenBy = providers\.keylessHealth\(\);/);
  assert.match(api, /broken: \(vendor && brokenBy\.get\(vendor\.toLowerCase\(\)\)\?\.reason\) \|\| null,/);

  const app = fs.readFileSync(pkg("src", "ui", "public", "app.js"), "utf8");
  const walk = app.slice(app.indexOf("function nextModel"), app.indexOf("let inFlight = null"));
  assert.match(walk, /if \(m\.broken\) continue;/, "the retry ladder skips a dead vendor");
  assert.match(walk, /m\.free && !m\.broken/, "so does the previously-verified shortcut");

  const picker = app.slice(app.indexOf("function openModelPicker"), app.indexOf("function openModePicker"));
  assert.match(picker, /if \(m\.broken && !showBroken\)/, "dead models are out of the list by default");
  // ⚠️ Hidden is not the same as gone. The measurement carries a date and a
  // vendor can recover, so there must always be a way back to them.
  assert.match(picker, /Show them anyway/);
  assert.match(picker, /showBroken = true;/);
  assert.match(picker, /if \(m\.broken\) bits\.push\(m\.broken\);/, "and the row says why");
});

test("a paid model wearing a free-looking prefix is filed under the key that pays for it", () => {
  // 🔴 Measured 2026-09-03 in the running app: 42 of the 94 models in the Free
  // lens were `no-think/openrouter/...` - the reader's own OpenRouter models
  // with thinking switched off, billed to their OpenRouter credit. `fromKey`
  // read only the FIRST segment of the id, so a transform namespace in front of
  // the real provider hid it completely. After the fix the Free lens holds 52
  // and "From your keys" holds 1046.
  const api = fs.readFileSync(pkg("src", "ui", "api.mjs"), "utf8");
  assert.match(api, /const keyVendor = segments\.find\(\(seg\) => keyed\.has\(seg\.toLowerCase\(\)\)\) \?\? null;/);
  assert.match(api, /fromKey: keyVendor !== null \|\| !free,/);
  // Whole segments only, or `ddgw/mistral-small-2603` would claim to be a
  // Mistral key - the keyless DuckDuckGo proxy serves that model name.
  assert.ok(!/keyed\.has\(id\.toLowerCase\(\)\)/.test(api));
  assert.ok(!/id\.includes\(alias\)/.test(api));

  const app = fs.readFileSync(pkg("src", "ui", "public", "app.js"), "utf8");
  assert.match(app, /from your \$\{m\.keyVendor\} key/, "the row must name the key, not the prefix");
  assert.ok(!/from your \$\{m\.vendor\} key/.test(app), "the first segment would read 'from your no-think key'");
});
