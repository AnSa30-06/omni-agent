// The desktop UI, checked where it can be checked without a running agent.
//
// Every assertion here corresponds to a bug that actually happened while
// building this. They are cheap; the failures they guard were not.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { nextRun } from "../../src/ui/routines.mjs";
import { routes } from "../../src/ui/api.mjs";
import { pkg } from "../../src/util/paths.mjs";

const ui = (...p) => fs.readFileSync(pkg("src", "ui", ...p), "utf8");

test("the client only talks to the API routes the server actually exposes", () => {
  // A typo in an /x/ name is a 404 the page reports as an empty section, which
  // is easy to mistake for "there is nothing to show".
  const app = ui("public", "app.js");
  const called = new Set([...app.matchAll(/\bapi\(\s*"([a-zA-Z]+)"/g)].map((m) => m[1]));
  assert.ok(called.size > 10, `expected the page to call many routes, saw ${called.size}`);
  for (const name of called) {
    assert.ok(Object.hasOwn(routes, name), `app.js calls /x/${name}, which src/ui/api.mjs does not define`);
  }
});

test("messages are sent and read through the same half of the OpenCode API", () => {
  // Measured 2026-08-27: a message sent via /session/{id}/message does not
  // appear in /api/session/{id}/message at all, so mixing the two produced a
  // transcript that stayed empty while tokens were being billed.
  const app = ui("public", "app.js");
  assert.ok(
    /ocall\("POST", `\/session\/\$\{id\}\/message`/.test(app),
    "sends must use the legacy /session/{id}/message route",
  );
  assert.ok(
    /ocall\("GET", `\/session\/\$\{state\.sessionID\}\/message`/.test(app),
    "reads must use the legacy /session/{id}/message route",
  );
  assert.ok(
    !/\/api\/session\/\$\{[^}]+\}\/prompt/.test(app),
    "/api/session/{id}/prompt accepts a message and never runs it - it must not be used",
  );
});

test("deleting a conversation uses the route that actually deletes", () => {
  // DELETE /api/session/{id} does not exist; it falls through to the app shell
  // and answers 200 with HTML, so the session survives a 'successful' delete.
  const app = ui("public", "app.js");
  assert.ok(/ocall\("DELETE", `\/session\/\$\{s\.id\}`\)/.test(app), "delete must use the legacy route");
  assert.ok(!/DELETE", `\/api\/session\//.test(app), "DELETE /api/session/{id} is not a real route");
});

test("a conversation is archived before it is deleted", () => {
  // The archiver runs on a timer, so without this a conversation deleted
  // inside that window would never have been backed up at all.
  const app = ui("public", "app.js");
  const i = app.indexOf('x.onclick');
  const del = app.slice(i, i + 900);
  assert.ok(
    del.indexOf("transcriptArchive") !== -1 && del.indexOf("transcriptArchive") < del.indexOf('"DELETE"'),
    "the delete handler must back up before deleting",
  );
});

test("the model picker sends the field name the route requires", () => {
  // ModelRef is {providerID, id}. Sending {providerID, modelID} returns 400 and
  // the session silently keeps OpenCode's own default model.
  const app = ui("public", "app.js");
  assert.ok(
    /model: \{ providerID: model\.providerID, id: model\.id \}/.test(app),
    "session model switch must send {providerID, id}",
  );
});

test("hidden elements are actually hidden", () => {
  // Every display rule in app.css is more specific than the browser default
  // for [hidden], so without an explicit rule `.hidden = true` does nothing.
  const css = ui("public", "app.css");
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});

test("the UI server requires its token on the API but not on the page itself", () => {
  const server = ui("server.mjs");
  assert.ok(
    /if \(p\.startsWith\("\/oc\/"\) \|\| p\.startsWith\("\/x\/"\)\) \{\s*\n\s*if \(!authorised\(req\)\)/.test(server),
    "the API must be token-guarded",
  );
  // app.js and app.css are fetched without a query string, so guarding them
  // returned 401 and left a page that rendered but never booted.
  assert.match(server, /loopback\(req\)/);
});

test("the agent server is given a password and the browser never sees it", () => {
  const oc = ui("opencode-server.mjs");
  assert.match(oc, /OPENCODE_SERVER_PASSWORD/);
  // Username is load-bearing: anything other than "opencode" is a 401.
  assert.match(oc, /Buffer\.from\(`opencode:\$\{_state\.password\}`\)/);
  const server = ui("server.mjs");
  // The page DOES show the gateway dashboard password - that one is the user's
  // own and they cannot sign in anywhere else without it. What it must never
  // see is the agent server credential, which the proxy attaches server-side.
  const app = ui("public", "app.js");
  assert.ok(!/OPENCODE_SERVER_PASSWORD/.test(app), "the page must never see the agent server password");
  assert.ok(!/Basic /.test(app), "the page must never build a Basic credential");
  assert.match(server, /authorization: c\.header/);
});

test("routine schedules compute a sane next run", () => {
  const at9 = { enabled: true, schedule: { kind: "daily", at: "09:00" } };
  const from = new Date(2026, 7, 28, 10, 0, 0).getTime(); // 10:00, after 09:00
  const next = new Date(nextRun(at9, from));
  assert.equal(next.getHours(), 9);
  assert.equal(next.getDate(), 29, "a daily 09:00 routine asked at 10:00 runs tomorrow");

  const weekdays = { enabled: true, schedule: { kind: "weekdays", at: "08:00" } };
  const friday = new Date(2026, 7, 28, 12, 0, 0).getTime(); // 2026-08-28 is a Friday
  const nd = new Date(nextRun(weekdays, friday));
  assert.ok(nd.getDay() !== 0 && nd.getDay() !== 6, "a weekday routine never lands on a weekend");

  assert.equal(nextRun({ enabled: false, schedule: { kind: "daily", at: "09:00" } }), null);

  const interval = { enabled: true, schedule: { kind: "interval", everyMinutes: 30 }, lastRun: from };
  assert.equal(nextRun(interval, from), from + 30 * 60_000);
});

test("an interval routine cannot be set to hammer the agent", () => {
  const r = { enabled: true, schedule: { kind: "interval", everyMinutes: 0 }, lastRun: 0 };
  const now = 10_000_000;
  const gap = nextRun(r, now) - now;
  assert.ok(gap >= 5 * 60_000 - 1, `interval floor should be 5 minutes, got ${gap}ms`);
});

test("the whole model catalogue is offered, not a healthy subset", () => {
  // usableOnly:true registered 81 of the gateway's 188 models, so over a
  // hundred free models were unreachable with no way to ask for them.
  const cfg = fs.readFileSync(pkg("src", "setup", "opencode-config.mjs"), "utf8");
  assert.match(cfg, /usableOnly:\s*false/, "the plugin must register every model the gateway can serve");
  // Offering everything is only honest with a way to search it and a way to
  // see what has already failed.
  const app = ui("public", "app.js");
  assert.match(app, /pop-search/, "the model picker needs a search box");
  assert.match(app, /failed here before/, "models that failed here must be marked");
});

test("a failed model is recorded from the fields the message actually carries", () => {
  // The legacy message carries modelID/providerID flat on `info`, and the
  // human-readable reason at error.data.message - error.message is undefined.
  const app = ui("public", "app.js");
  assert.match(app, /m\.info\?\.providerID/);
  assert.match(app, /m\.info\?\.modelID/);
  assert.match(app, /err\.data\?\.message/);
});

test("preferences are stored on the server, not in the browser", () => {
  // A fresh port each launch makes the page a new origin, so localStorage is
  // empty on every restart.
  const app = ui("public", "app.js");
  assert.ok(!/localStorage\.(get|set)Item/.test(app), "app.js must not persist state in the browser");
  assert.ok(Object.hasOwn(routes, "prefsGet") && Object.hasOwn(routes, "prefsSet"));
});

test("conversations are named from the first thing asked", () => {
  const app = ui("public", "app.js");
  assert.match(app, /function nameFromPrompt/);
  assert.match(app, /isPlaceholderTitle/);
  assert.match(app, /PATCH", `\/session\/\$\{id\}`/, "renaming uses the legacy PATCH route");
});

test("the app is branded as Omni Agent, with no borrowed marks", () => {
  const html = ui("public", "index.html");
  const app = ui("public", "app.js");
  assert.match(html, /<title>Omni Agent<\/title>/);
  assert.match(html, /class="brand-name">Omni Agent</);
  assert.match(html, /logo\.svg/);
  // The empty state used an asterisk glyph borrowed from another product.
  assert.ok(!html.includes("✳") && !app.includes("✳"), "the borrowed asterisk mark must be gone");
  assert.ok(fs.existsSync(pkg("src", "ui", "public", "logo.svg")));
});

test("the page ships no external references", () => {
  // The window runs under a content-security-policy that forbids the network,
  // so anything remote is a silently broken asset.
  for (const f of ["index.html", "app.css", "app.js"]) {
    const src = ui("public", f);
    assert.ok(!/https?:\/\/(?!127\.0\.0\.1)/.test(src.replace(/^\s*\/\/.*$/gm, "")), `${f} references a remote URL`);
  }
});

test("every public asset the page asks for exists", () => {
  const html = ui("public", "index.html");
  const dir = pkg("src", "ui", "public");
  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const ref = m[1];
    if (/^https?:/.test(ref)) continue;
    assert.ok(fs.existsSync(path.join(dir, ref)), `index.html references ${ref}, which does not exist`);
  }
});

test("a conversation is created in the chosen folder, on the route that honours it", () => {
  // Measured 2026-08-28: POST /api/session?directory=X answers 200 and ignores
  // the directory - the session comes back rooted in the default workspace -
  // while POST /session?directory=X honours it. A session created on the wrong
  // route looks completely normal and quietly works in the wrong place.
  const app = ui("public", "app.js");
  assert.match(app, /ocall\("POST", "\/session" \+ q, \{\}\)/, "new sessions must use the legacy route");
  assert.ok(!/ocall\("POST", "\/api\/session"/.test(app), "POST /api/session ignores ?directory=");
  assert.match(app, /"\?directory=" \+ encodeURIComponent\(dir\)/);
});

test("the folder picker refuses anything that is not an existing directory", async () => {
  // OpenCode accepts a nonexistent `directory` without complaint, and the
  // failure only shows up later as an agent that cannot find any files.
  const here = pkg("src", "ui", "api.mjs");
  assert.equal((await routes.folderSet({ body: { path: "" } })).ok, false);
  assert.equal((await routes.folderSet({ body: {} })).ok, false);
  const missing = await routes.folderSet({ body: { path: path.join(pkg(), "no-such-folder-xyz") } });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /does not exist/);
  const file = await routes.folderSet({ body: { path: here } });
  assert.equal(file.ok, false);
  assert.match(file.error, /is a file, not a folder/);
});

test("the folder picker does not block the server while the dialog is open", () => {
  // execFileSync would freeze the UI server's event loop for as long as the
  // user browses - the whole app appears to hang mid-click.
  const api = ui("api.mjs");
  const pick = api.slice(api.indexOf("async folderPick("), api.indexOf("// --- transcripts"));
  assert.ok(!/execFileSync\(/.test(pick), "the folder picker must not call execFileSync");
  assert.match(pick, /spawn\("powershell\.exe"/);
  assert.match(pick, /-STA/, "FolderBrowserDialog needs a single-threaded apartment");
});

test("live updates come from the global event stream, not the route that never answers", () => {
  // Measured 2026-08-28: GET /api/session/{id}/event never sends response
  // headers at all - the request hangs until it is aborted. The page had an
  // EventSource pointed at it, so no event ever arrived and the transcript
  // only updated when the send request finally returned. That is why answers
  // landed in one lump instead of streaming.
  const app = ui("public", "app.js");
  assert.match(app, /new EventSource\(`\/oc\/event\?/, "the stream must be the global /event");
  assert.ok(
    !/EventSource\(`\/oc\/api\/session\//.test(app),
    "/api/session/{id}/event never sends headers; it must not be subscribed to",
  );
  // A global stream carries other conversations, so it has to be filtered.
  assert.match(app, /q\.sessionID !== state\.sessionID/);
});

test("streamed text fades from transparent and can never be left invisible", () => {
  // The fade must run FROM transparent rather than parking the element at
  // opacity 0 and animating it back: those look identical while animations
  // run, and the second leaves the whole answer permanently invisible in a
  // throttled tab or on a compositor that is not running.
  const css = ui("public", "app.css");
  const rule = /\.tok\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, ".tok must exist");
  assert.ok(!/opacity\s*:\s*0/.test(rule[1]), ".tok must not set opacity: 0 as its resting state");
  assert.match(rule[1], /animation:[^;]*forwards/, "the fade must use forwards");
  assert.ok(!/animation:[^;]*\bboth\b/.test(rule[1]), "`both` implies backwards, which pins it invisible");
  assert.match(css, /@keyframes tok-in\s*\{\s*from\s*\{\s*opacity:\s*0/);
  assert.match(css, /prefers-reduced-motion:\s*reduce[\s\S]{0,400}\.tok\s*\{\s*animation:\s*none/);
});

test("a streaming turn is written into, never re-rendered", () => {
  // Re-rendering the transcript on every event restarts every fade animation
  // on every frame and makes the text strobe.
  const app = ui("public", "app.js");
  assert.match(app, /if \(t\.startsWith\("session\."\) && !live\.turn\) scheduleRefresh\(\)/);
  assert.match(app, /live\.parts\.set\(/, "parts are keyed so a tool updates in place instead of stacking");
});

test("the view follows a live answer instead of measuring how far away it is", () => {
  // Measuring "am I near the bottom?" per token is always false in a
  // conversation with history, so the view never follows the answer.
  const app = ui("public", "app.js");
  assert.match(app, /let stickToBottom = true/);
  assert.match(app, /behavior: "auto"/, "a re-triggered smooth scroll never arrives");
  assert.ok(
    !/const atBottom = box\.scrollHeight/.test(app),
    "the per-render near-bottom measurement is the broken version",
  );
});

test("a model that refuses is retried on a different model, not left as a dead end", () => {
  // Measured 2026-08-28 on a genuinely clean keyless install: the very first
  // message failed with
  //   [401]: Model north-mini-code-free is not supported ... invalid_api_key
  // because the default auto/ combo resolved to a model needing a key. The CLI
  // already survives this - doctor reports "answered after falling back from
  // auto/cheap" - and only the app path had no fallback at all.
  const app = ui("public", "app.js");
  assert.match(app, /function isModelFailure/);
  assert.match(app, /function retryOnAnotherModel/);
  assert.match(app, /if \(retryOnAnotherModel\(\)\) return;/, "the end of a turn must attempt the retry");
  // Bounded: silently working through a hundred models spends the user's time.
  assert.match(app, /inFlight\.tries >= 2/);
});

test("the retry never picks an auto/ combo, and never a paid model", () => {
  // An auto combo resolves to some other model at request time, so recording
  // ITS id as unhealthy blames the wrong thing - and blacklists a router that
  // may work next time. It is also what failed in the first place.
  const app = ui("public", "app.js");
  const fn = app.slice(app.indexOf("function nextModel("), app.indexOf("/** What is in flight"));
  assert.match(fn, /m\.id\.startsWith\("auto\/"\)/, "auto/ combos must be skipped");
  assert.match(fn, /!m\.free/, "a keyless install must not be sent to a paid model");
  assert.match(fn, /Object\.keys\(state\.unhealthy\)/, "models that already failed here must be skipped");
});

test("a fallback is announced and remembered, never silent", () => {
  // Honesty rule: the product may not quietly substitute a different model and
  // present the answer as though nothing happened.
  const app = ui("public", "app.js");
  const fn = app.slice(app.indexOf("function retryOnAnotherModel("), app.indexOf("async function send("));
  assert.match(fn, /toast\(`\$\{was\} would not answer\. Retrying with \$\{next\.name\}\.`\)/);
  assert.match(fn, /savePrefs\(\{ model: state\.model \}\)/, "the working model becomes the default");
  assert.match(fn, /inFlight\.id !== state\.sessionID/, "must not resurrect a prompt from a left conversation");
});

test("the turn's bookkeeping survives the error/idle pair", () => {
  // endTurn runs for BOTH session.error and session.idle. Clearing inFlight in
  // it means the idle right after a failure wipes the retry that the error just
  // started, and the retry's own failure then has nowhere to record itself.
  const app = ui("public", "app.js");
  const fn = app.slice(app.indexOf("function endTurn("), app.indexOf("let refreshTimer"));
  assert.ok(!/^\s*inFlight = null;/m.test(fn), "endTurn must not clear inFlight");
});

test("any errored turn that produced no text is treated as a model that did not answer", () => {
  // This began as a list of status codes and the list kept growing: three
  // consecutive attempts on a clean keyless install failed three different ways
  //   [401] Model north-mini-code-free is not supported ... invalid_api_key
  //   [502] fetch failed
  //   [418] DuckDuckGo anti-abuse challenge failed: ERR_BN_LIMIT
  // Enumerating the taxonomy of a free model pool is a losing game, so the rule
  // is the reader's question instead: did an answer arrive?
  const app = ui("public", "app.js");
  const fn = app.slice(app.indexOf("function isModelFailure("), app.indexOf("function nextModel("));
  assert.ok(!/statusCode\s*===/.test(fn), "must not enumerate status codes");
  assert.match(fn, /if \(gotText\) return false/, "a partial answer is an answer");
  assert.match(fn, /abort\|cancell\?ed/, "a reader who pressed stop must not trigger a retry");
  assert.match(fn, /return true;\s*\}/, "anything else counts as a failure");
  // And the caller has to supply whether text arrived, or the guard is dead.
  assert.match(app, /isModelFailure\(inFlight\.error, gotText\)/);
  assert.match(app, /const gotText = .*stream-text/);
});

test("the retry moves to a different vendor, not another model from the one that just failed", () => {
  // Measured: a rate-limited DuckDuckGo returned the identical
  //   [418] anti-abuse challenge failed: ERR_BN_LIMIT
  // for two different models in a row, so the second retry was spent before it
  // was made. The gateway serves every vendor under one provider id, so the
  // vendor is the first segment of the MODEL id, not the provider id.
  const app = ui("public", "app.js");
  const fn = app.slice(app.indexOf("function nextModel("), app.indexOf("/** What is in flight"));
  assert.match(fn, /const vendor = /);
  assert.match(fn, /for \(const strict of \[true, false\]\)/, "a vendor preference that can be relaxed, not a hard filter");
  assert.match(fn, /strict && spent\.has\(vendor\(m\.id\)\)/);
});

test("a fresh install starts on the model setup measured, not the one it was told about", () => {
  // The other half of the 401 fix. The retry ladder rescues a bad first
  // message; this stops there being one. Order is load-bearing: the user's own
  // choice still wins, so re-running setup can never move them off a model they
  // picked - it only fills the slot when nothing has been chosen.
  const app = ui("public", "app.js");
  const fn = app.slice(app.indexOf("async function loadModels("), app.indexOf("function paintModel("));
  assert.match(fn, /state\.verifiedModel/, "the measured model must be consulted");
  assert.ok(
    fn.indexOf("if (known(saved)) state.model = saved;") < fn.indexOf("else if (verified)"),
    "a model the user chose must outrank the one setup measured",
  );
  assert.ok(
    fn.indexOf("else if (verified)") < fn.indexOf("else if (r.configured)"),
    "a measured model must outrank the gateway's published default, which is the auto/ combo that 401'd",
  );
  // And it has to survive a restart, or the fix only holds for one session.
  assert.match(app, /state\.verifiedModel = prefs\.verifiedModel \?\? null;/);
});
