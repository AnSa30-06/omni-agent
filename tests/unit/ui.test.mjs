// The desktop UI, checked where it can be checked without a running agent.
//
// Every assertion here corresponds to a bug that actually happened while
// building this. They are cheap; the failures they guard were not.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
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

test("the pickers do not block the server while a dialog is open", () => {
  // execFileSync would freeze the UI server's event loop for as long as the
  // user browses - the whole app appears to hang mid-click.
  const api = ui("api.mjs");
  const run = api.slice(api.indexOf("async function showDialog("), api.indexOf("How a chosen file should"));
  assert.ok(!/execFileSync\(/.test(api), "no picker may call execFileSync");
  assert.match(run, /spawn\("powershell\.exe"/);
  assert.match(run, /-STA/, "both dialogs need a single-threaded apartment");
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
  // The model that ANSWERS becomes the default - persisted in endTurn once the
  // retry produced text, never at retry time (that saved a model before it had
  // answered, and it had usually just failed).
  assert.ok(!/savePrefs\(\{ model: state\.model \}\)/.test(fn), "the retry does not persist an unanswered model");
  assert.match(app, /gotText && !inFlight\?\.error && inFlight\?\.tries > 0 && state\.model[\s\S]*?savePrefs\(\{ model: state\.model \}\)/, "the model that produced the answer becomes the default");
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
    fn.indexOf("if (known(saved) && healthy(saved)) state.model = saved;") < fn.indexOf("else if (verified && healthy(verified))"),
    "a healthy model the user chose must outrank the one setup measured",
  );
  assert.ok(
    fn.indexOf("else if (verified && healthy(verified))") < fn.indexOf("else if (r.configured)"),
    "a measured model must outrank the gateway's published default, which is the auto/ combo that 401'd",
  );
  // A model that already FAILED here is skipped, but never at the cost of
  // starting on nothing - a still-known saved model is the last resort.
  assert.ok(
    fn.indexOf("else if (r.configured)") < fn.indexOf("else if (known(saved))"),
    "an unhealthy-but-known model is only the last resort",
  );
  // And it has to survive a restart, or the fix only holds for one session.
  assert.match(app, /state\.verifiedModel = prefs\.verifiedModel \?\? null;/);
});

test("the picker's owner window is never Show()n", () => {
  // 🔴 The regression this guards is silent and total. The picker is spawned
  // with windowsHide, which arms a one-shot SW_HIDE that Windows spends on the
  // first window the process shows. Show() spends it on the owner, the owner is
  // hidden, and the dialog it owns is hidden with it - measured: the child exits
  // 0 in under a second, prints nothing, and the app reports a cancelled picker
  // the user never saw. Touching .Handle makes the window without ShowWindow.
  const api = fs.readFileSync(pkg("src", "ui", "api.mjs"), "utf8");
  const owner = api.slice(api.indexOf("const DIALOG_OWNER = ["), api.indexOf("const FOLDER_DIALOG"));
  assert.ok(!/\$owner\.Show\(\)/.test(owner), "Show() hides the dialog - use $owner.Handle");
  assert.match(owner, /\$null = \$owner\.Handle/, "the owner window still has to exist");
  assert.match(api, /if \(dialogOpen\) return bad/, "a second click must not stack a second dialog");
});

test("a chosen file is described by what can actually be done with it", async () => {
  // Text small enough to inline goes as a file part, which puts its CONTENTS in
  // front of the model. Everything else is a path for the agent's own readers -
  // the default free models are not vision models, and a binary pushed at one
  // fails the whole turn.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-files-"));
  const txt = path.join(dir, "notes.md");
  const bin = path.join(dir, "scan.pdf");
  const big = path.join(dir, "huge.log");
  fs.writeFileSync(txt, "hello");
  fs.writeFileSync(bin, "%PDF-1.4");
  fs.writeFileSync(big, "x".repeat(300 * 1024));

  const r = await routes.fileDescribe({ body: { paths: [txt, bin, big, path.join(dir, "nope.txt")] } });
  assert.equal(r.ok, true);
  assert.equal(r.files.length, 3, "a path that does not exist is dropped, not reported as a file");
  const [a, b, c] = r.files;
  assert.equal(a.inline, true);
  assert.equal(a.mime, "text/markdown");
  assert.equal(b.inline, false, "a PDF must not be inlined");
  assert.equal(c.inline, false, "a 300 KB log must not be inlined - it would spend the context window");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("attachments reach the model, and a retry sends the same ones", () => {
  const app = ui("public", "app.js");
  const fn = app.slice(app.indexOf("function attachmentParts("), app.indexOf("/* -- the working folder"));
  assert.match(fn, /type: "file"/, "an inlinable file goes as a file part");
  assert.match(fn, /"file:\/\/" \+ f\.path\.replace/, "the url must be a file:// URL");
  assert.match(fn, /Use these files, reading them yourself/, "a non-inlinable file has to be named in words");
  // The retry ladder re-sends the message; it must re-send the files with it.
  assert.match(app, /inFlight = \{ id, text, extra,/);
  assert.match(app, /postMessage\(inFlight\.id, inFlight\.text, inFlight\.extra\)/);
  // And the chips must clear, or the next message re-sends them.
  assert.match(app, /attachments = \[\];\s*\n\s*paintAttachments\(\);\s*\n\s*inFlight/);
});

test("OpenCode's own expansion of an attachment is not shown as the reader's words", () => {
  // A file part is expanded server-side into "Called the Read tool with…" and a
  // <path> block, both flagged `synthetic`. Rendered as-is they sit above the
  // reader's own message and read as though THEY called a tool.
  const app = ui("public", "app.js");
  assert.match(app, /} else if \(part\.synthetic\) \{/);
  assert.match(app, /if \(part\.type === "file"\) \{/, "an attachment should render as its own chip");
});

test("an MCP connection is wrapped the way OpenCode wants, and survives a restart", () => {
  // POST /mcp takes { name, config } with additionalProperties:false on both
  // levels, so the old flat { name, type, command, enabled } failed validation
  // on the unexpected `type` AND the missing `config.command` - and surfaced as
  // "command required", pointing at a field the user had filled in.
  const api = fs.readFileSync(pkg("src", "ui", "api.mjs"), "utf8");
  const fn = api.slice(api.indexOf("  async mcpAdd("), api.indexOf("  async mcpRemove("));
  assert.match(fn, /oc\("POST", "\/mcp", \{ name, config \}\)/);
  assert.match(fn, /type: "remote", url/, "a URL is a remote server");
  assert.match(fn, /type: "local", command/, "anything else is a command");
  // The route connects it for the RUNNING process and writes nothing, so an
  // added connection was gone after a restart until this was added.
  assert.match(fn, /updateConfig\(/);
  assert.match(fn, /writeOpenCodeConfig\(\)/);
  const oc = fs.readFileSync(pkg("src", "setup", "opencode-config.mjs"), "utf8");
  assert.match(oc, /if \(cfg\.mcp && Object\.keys\(cfg\.mcp\)\.length\) config\.mcp = cfg\.mcp;/);
});

test("the model list is retried while the gateway is still warming up", () => {
  // The gateway takes up to a minute on a cold first run. This was fetched once
  // at boot, so a page that opened first said "No models available yet" for
  // good, and only a reload fixed it.
  const app = ui("public", "app.js");
  const fn = app.slice(app.indexOf("async function loadModels("), app.indexOf("function paintModel("));
  assert.match(fn, /loadModels\(retries = \d+\)/);
  assert.match(fn, /if \(!state\.models\.length && retries > 0\)/);
  assert.match(fn, /setTimeout\(\(\) => loadModels\(retries - 1\), \d+\)/);
});

test("reasoning is hidden until it is asked for, and Ctrl+O is what asks", () => {
  // A reasoning block is routinely longer than the answer it precedes, so
  // shown by default it buries the thing the reader wanted. Ctrl+O because
  // Ctrl+R reloads the page and Ctrl+T opens a tab.
  const app = ui("public", "app.js");
  assert.match(app, /if \(!state\.showReasoning\) continue;/, "reasoning must be dropped at render time");
  assert.match(app, /state\.showReasoning = prefs\.showReasoning === true;/, "off unless the reader turned it on");
  assert.match(app, /savePrefs\(\{ showReasoning: state\.showReasoning \}\)/, "the choice has to survive a restart");
  // The binding must not fire while the reader is typing, or it becomes a
  // shortcut they turn off.
  const key = app.slice(app.indexOf('if (e.key !== "o"'), app.indexOf("toggleReasoning();\n  });"));
  assert.match(key, /HTMLInputElement \|\| t instanceof HTMLTextAreaElement/);
  assert.match(key, /ctrlKey \|\| e\.metaKey/);
});

test("a model says which upstream it comes from, and the picker can filter on it", () => {
  // Every model the gateway serves arrives under ONE provider id, so a key's
  // models were mixed into the same list with nothing to tell them apart -
  // which is exactly the question "which models did my OpenRouter key give me?"
  const api = fs.readFileSync(pkg("src", "ui", "api.mjs"), "utf8");
  assert.match(api, /const vendor = id\.includes\("\/"\) \? id\.slice\(0, id\.indexOf\("\/"\)\) : null;/);
  const app = ui("public", "app.js");
  assert.match(app, /lensBtn\("keys", "From your keys"\)/);
  assert.match(app, /from your \$\{m\.vendor\} key/);
  // A search that finds nothing must name the route out, not dead-end.
  assert.match(app, /Adding the provider's key in Providers puts its models in this list/);
});

test("\"from your keys\" is decided by the gateway's connections, not by price", () => {
  // The defect this replaced: a free-tier key (Mistral, Cerebras, GitHub
  // Models) serves at zero cost, so a cost-based split filed the reader's own
  // newly added models under "Free" and left "From your keys" showing nothing.
  const api = fs.readFileSync(pkg("src", "ui", "api.mjs"), "utf8");
  const fn = api.slice(api.indexOf("  async models("), api.indexOf("   * Usage, as percentages"));
  assert.match(fn, /const conn = await providers\.connected\(\);/, "the connection list is the authority");
  // A model id is prefixed with the provider's ALIAS, and 109 of the gateway's
  // 222 providers have one that differs from their id (`github-models` serves
  // `ghm/...`), so matching the id alone would miss half of them.
  assert.match(fn, /const alias = mf\?\.get\(id\)\?\.alias;/);
  assert.match(fn, /fromKey: \(vendor !== null && keyed\.has\(vendor\.toLowerCase\(\)\)\) \|\| !free,/);
  assert.match(fn, /connectionsKnown: conn\.ok === true,/, "an unreachable gateway must not read as 'no keys'");

  const app = ui("public", "app.js");
  assert.match(app, /if \(lens === "keys" && !m\.fromKey\) return false;/);
  // Free means "here without an account", so a keyed free-tier model is not in
  // it. The two lenses have to be disjoint or the reader cannot tell them apart.
  assert.match(app, /if \(lens === "free" && \(!m\.free \|\| m\.fromKey\)\) return false;/);
  assert.match(app, /state\.connectionsKnown = r\.connectionsKnown === true;/);
  assert.match(app, /the gateway did not answer when asked which keys are connected/i);
});

test("adding a provider key reports what it unlocked, not just that it was stored", () => {
  // "Key added" does not answer the question the reader is asking, which is
  // "so what can I use now?"
  const api = fs.readFileSync(pkg("src", "ui", "api.mjs"), "utf8");
  const fn = api.slice(api.indexOf("  async providerAdd("), api.indexOf("  async providerSignin("));
  // Counted against the gateway rather than OpenCode: the plugin caches its
  // model list for five minutes, so immediately after adding a key the old
  // modelIds() diff came back EMPTY while the gateway had gone from 119 models
  // to 1151 - which also left the key check with nothing to probe.
  assert.match(fn, /const before = await gatewayIds\(\);/);
  assert.match(fn, /const after = await gatewayIds\(\);/);
  assert.match(fn, /newModels: fresh\.length/);
});

test("the window opens before the slow parts start, and the page waits on a startup screen", () => {
  // Before this the exe showed NOTHING until the gateway (up to a minute cold)
  // and the agent were both up. That reads as "it did not work", and the
  // natural response - double-click again - started a second copy of
  // everything. Now the window opens first and shows each step as it happens.
  const launch = ui("launch.mjs");
  const body = launch.slice(launch.indexOf("export async function launchUI"));
  const iServer = body.indexOf("await startServer()");
  const iWindow = body.indexOf("openWindow(url)");
  const iUp = body.indexOf("await bringUp(say)");
  assert.ok(iServer > 0 && iWindow > iServer, "launch.mjs must serve the page and open the window first");
  assert.ok(iUp > iWindow, "the gateway and the agent must be started after the window is open");
  const up = launch.slice(launch.indexOf("async function bringUp"), launch.indexOf("export async function launchUI"));
  assert.ok(up.indexOf("ensureRunning(") !== -1 && up.indexOf("startAgent(") > up.indexOf("ensureRunning("), "inside bringUp the gateway still starts before the agent");
  const app = ui("public", "app.js");
  assert.match(app, /await waitForReady\(\)/, "boot must wait for the stack before loading models and sessions");
  assert.ok(
    !/restart Omni Agent/.test(app),
    "the old 'agent server is not running - restart' toast fired at someone who had just started it",
  );
  const html = ui("public", "index.html");
  assert.match(html, /id="startup"/, "the startup screen is static markup so it paints before app.js loads");
});

test("missing components are explained with a way out, never as an npm command", () => {
  // What a person gets when they untick "Finish setup now" in the installer
  // and then double-click the desktop icon. It used to be a dialog saying
  // "Install it with: npm install -g opencode-ai".
  const launch = ui("launch.mjs");
  assert.match(launch, /omniroute-not-installed\|OpenCode is not installed/, "both missing-component reasons are recognised");
  assert.match(launch, /action: "setup"/, "a missing component offers to run setup");
  assert.ok(!/npm install/.test(launch), "launch.mjs must not tell a user to run npm");
  assert.ok(Object.hasOwn(routes, "setupRun"), "the page can start setup");
  assert.ok(Object.hasOwn(routes, "startupRetry"), "the page can try the start again");
});

test("the startup state reports each step, then a problem with an action, then ready", async () => {
  const s = await import("../../src/ui/startup.mjs");
  s.startupBegin([
    { id: "gateway", label: "Starting the model gateway" },
    { id: "agent", label: "Starting the agent" },
  ]);
  s.startupStep("gateway", "running", "still starting...");
  let snap = s.startupSnapshot();
  assert.equal(snap.ready, false);
  assert.equal(snap.steps[0].status, "running");
  assert.equal(snap.steps[0].note, "still starting...");
  assert.equal(snap.steps[1].status, "pending");
  s.startupStep("gateway", "failed", "omniroute-not-installed");
  s.startupProblem({ title: "Omni Agent has not finished setting itself up", action: "setup", actionLabel: "Finish setup" });
  snap = s.startupSnapshot();
  assert.equal(snap.problem.action, "setup");
  assert.equal(snap.problem.actionLabel, "Finish setup");
  // Nothing registered: a retry says so instead of pretending.
  assert.equal(s.retry().ok, false);
  s.startupReady();
  snap = s.startupSnapshot();
  assert.equal(snap.ready, true);
  assert.equal(snap.problem, null, "a problem is cleared once the start succeeds");
});

test("a tool call reads as a sentence, in the live view and the settled one", () => {
  // "bash" and a block of JSON tell a beginner nothing about what just
  // happened to their files. Both render paths go through one describer, so
  // the words cannot drift apart between streaming and the re-render.
  const app = ui("public", "app.js");
  assert.equal((app.match(/paintToolSummary\(/g) ?? []).length, 3, "declared once, used by the live path and the render path");
  assert.match(app, /case "bash":\s*\n\s*return \["Running"/);
  assert.match(app, /case "edit":[\s\S]*?return \["Editing"/);
  assert.match(app, /case "write":\s*\n\s*return \["Writing"/);
  assert.match(app, /case "web_search":\s*\n\s*return \["Searching the web"/);
  assert.match(app, /sum\.title = name;/, "the raw tool name stays reachable as a tooltip");
  assert.ok(!/el\("span", "tool-name", name\)/.test(app), "the raw tool name is no longer the headline");
});

test("a turn ends with what it changed and that it finished", () => {
  // OpenCode records the turn's file diffs on the USER message once it
  // settles; that is the authority, with the write/edit tool calls as the
  // fallback for a turn whose summary has not landed yet.
  const app = ui("public", "app.js");
  assert.match(app, /turn\.user\?\.info\?\.summary \?\? turn\.user\?\.summary/, "diffs come from the user message's summary");
  assert.match(app, /if \(!file \|\| out\.has\(file\)\) continue;/, "a tool call never overrides a file the summary covers");
  assert.match(app, /Finished in \$\{fmtSecs\(secs\)\}/);
  assert.match(app, /if \(!done \|\| info\.error\) return;/, "an errored or still-running turn gets no 'finished' line");
  assert.match(app, /api\("openFolder", \{ method: "POST", body: \{ path: folder \} \}\)/, "the card can open the folder");
  assert.ok(Object.hasOwn(routes, "openFolder"));
});

test("opening a folder refuses anything that is not there", async () => {
  const r = await routes.openFolder({ body: { path: path.join(os.tmpdir(), "omni-agent-no-such-dir-" + Date.now()) } });
  assert.equal(r.ok, false);
  assert.match(r.error, /does not exist/);
  const r2 = await routes.openFolder({ body: {} });
  assert.equal(r2.ok, false);
});

test("the event stream is scoped to the conversation's folder", () => {
  // The agent publishes streaming tokens, tool calls and permission requests on
  // a bus keyed by directory. A stream opened without it is silent for every
  // folder but the default one - so "watch it work" was blank for anyone who
  // chose their own folder, and a permission prompt never arrived. Verified
  // live 2026-09-02: a custom-folder turn streamed 14 text deltas + 3 tool
  // events on the scoped stream and zero on the unscoped one.
  const app = ui("public", "app.js");
  assert.match(app, /function subscribe\(sessionID, directory\)/, "subscribe takes the folder");
  assert.match(app, /if \(directory\) qs\.set\("directory", directory\)/, "the folder is added to the stream URL");
  assert.match(app, /subscribe\(id, state\.sessionFolder\)/, "openSession subscribes with the session's own folder");
  // The folder must be known BEFORE subscribing, so the GET is awaited, not
  // fire-and-forget.
  assert.match(app, /const d = await ocall\("GET", `\/session\/\$\{id\}`\)/, "the directory is fetched before subscribing");
  assert.match(app, /await openSession\(id\)/, "newSession awaits openSession so the stream is live before the first message");
});

test("Stop uses the route that actually ends the turn, and a stop is not a failure", () => {
  // /api/session/{id}/interrupt (v2) is a no-op for a turn started on the
  // legacy message route - files kept being written after "Stop". /abort ends
  // it with MessageAbortedError. Verified live 2026-09-02.
  const app = ui("public", "app.js");
  const wire = app.slice(app.indexOf('$("btn-stop").onclick'));
  assert.match(wire, /ocall\("POST", `\/session\/\$\{state\.sessionID\}\/abort`/, "Stop calls /abort");
  assert.ok(!/ocall\([^)]*\/interrupt`/.test(app), "the no-op interrupt CALL is gone (a comment may still name it)");
  const stopBlock = app.slice(app.indexOf('$("btn-stop").onclick'), app.indexOf('$("attach-btn").onclick'));
  // Strip the explanatory comment before checking: the code must not call
  // setBusy(false) (the comment says it deliberately does not).
  const stopCode = stopBlock.replace(/\/\/.*/g, "");
  assert.ok(!/setBusy\(false\)/.test(stopCode), "Stop lets the turn settle instead of hiding the button blindly");
  assert.match(app, /err\.name === "MessageAbortedError"[\s\S]*?Stopped by you/, "an aborted turn renders 'Stopped by you', not a model-failure card");
});

test("an agent that dies is detected, restarted, and recovered on the page", () => {
  // When opencode.exe exits on its own the page used to 503 every call, throw
  // on .filter, and sit blank forever with startup.ready still true. Verified
  // live 2026-09-02: killing the agent flipped status to not-ready and a new
  // agent came up healthy in ~2.3 s.
  const oc = ui("opencode-server.mjs");
  assert.match(oc, /let _stopping = false;/, "a deliberate stop is distinguished from a crash");
  assert.match(oc, /if \(wasDeliberate\)[\s\S]*?else[\s\S]*?onExit\?\.\(code\)/, "an unexpected exit calls onExit");
  assert.match(oc, /_stopping = true;/, "stop() marks the shutdown deliberate");

  const launch = ui("launch.mjs");
  assert.match(launch, /onExit: \(code\) => onAgentExit\(code, say\)/, "the agent is started with a crash hook");
  assert.match(launch, /if \(agentCrashes <= 3\)[\s\S]*?retryStartup\(\)/, "a crash restarts the agent, bounded");
  assert.match(launch, /The agent keeps stopping/, "repeated crashes show a problem the reader can act on");
  assert.match(launch, /agentCrashes = 0;/, "a clean bring-up resets the crash counter");

  const app = ui("public", "app.js");
  assert.match(app, /if \(r\.status === 503\) recover\(\)/, "a 503 on any agent call starts recovery");
  assert.match(app, /async function recover\(\)/, "recover re-shows the startup screen and reloads");
  assert.match(app, /const list = r\.data\?\.data \?\? r\.data;\s*\n\s*state\.sessions = Array\.isArray\(list\) \? list : \[\]/, "a 503 body is never treated as a session list");
});

test("a failed model is never saved as the default, and a fresh start avoids one", () => {
  // Measured 2026-09-02: the first question failed, the retry's model was saved
  // before it answered, and the next conversation opened on that failed model
  // and failed again. Now only the model that ANSWERS is remembered, and a
  // conversation never opens on a model recorded as unhealthy.
  const app = ui("public", "app.js");
  const retry = app.slice(app.indexOf("function retryOnAnotherModel"), app.indexOf("async function send"));
  assert.ok(!/savePrefs\(\{ model: state\.model \}\)/.test(retry), "the retry does not persist a model that has not answered");
  assert.match(app, /gotText && !inFlight\?\.error && inFlight\?\.tries > 0 && state\.model[\s\S]*?savePrefs\(\{ model: state\.model \}\)/, "endTurn persists the model that produced the answer");
  assert.match(app, /const healthy = \(m\) => m && !recentlyFailed\(/, "loadModels knows which models have failed here recently");
  assert.match(app, /if \(known\(saved\) && healthy\(saved\)\) state\.model = saved;/, "a healthy saved model is preferred");
  assert.match(app, /else if \(verified && healthy\(verified\)\) state\.model = verified;/, "a healthy verified model is next");
  // A still-known-but-unhealthy saved model is the last resort, never nothing.
  assert.match(app, /else if \(known\(saved\)\) state\.model = saved;/, "there is still a fallback when everything is unhealthy");
});

test("a model that says nothing is given up on, not waited out", () => {
  // Measured 2026-09-02: a rate-limited model was waited on for 84 s before the
  // upstream gave up, so a first question could dead-end for 2.5 minutes with
  // nothing on screen. A working model on the same busy pool answered in 9.7 s.
  const app = ui("public", "app.js");
  assert.match(app, /const FIRST_TOKEN_TIMEOUT_MS = 25_000;/, "there is a first-token deadline");
  assert.match(app, /watchdog = setTimeout\(giveUpOnModel, FIRST_TOKEN_TIMEOUT_MS\)/, "the deadline is armed");
  assert.match(app, /armWatchdog\(\);/, "postMessage arms it");
  // Cleared for good on the first sign of life, so a slow-but-working stream is
  // never killed part way through.
  assert.match(app, /function sawFirstToken\(\)[\s\S]*?clearWatchdog\(\)[\s\S]*?clearWaiting\(\)/);
  const sub = app.slice(app.indexOf("function subscribe(sessionID, directory)"), app.indexOf("function setBusy"));
  assert.ok((sub.match(/sawFirstToken\(\);/g) ?? []).length >= 2, "both a text delta and a tool call count as a sign of life");
  // Giving up aborts, so the abandoned request stops competing with the retry.
  assert.match(app, /giveUpOnModel[\s\S]*?ocall\("POST", `\/session\/\$\{inFlight\.id\}\/abort`/);
});

test("a turn the app abandoned is never reported as finished or as the reader's doing", () => {
  // Aborting a model that produced NOTHING completes its message with no error
  // at all, so the transcript printed "Finished in 22s" for a model that never
  // said a word. It must also not say "Stopped by you" - the reader did not.
  const app = ui("public", "app.js");
  assert.match(app, /noAnswer: new Set\(\)/, "the app records which turns it abandoned");
  assert.match(app, /if \(inFlight\.assistantID\) state\.noAnswer\.add\(inFlight\.assistantID\)/);
  // The id is available early: message.updated names the assistant message
  // about 8 s before its first content.
  assert.match(app, /info\?\.role === "assistant" && info\?\.id && inFlight\) inFlight\.assistantID = info\.id/);
  const fStart = app.indexOf("function finishTurn");
  const finish = app.slice(fStart, app.indexOf("\nfunction ", fStart + 10));
  assert.match(finish, /state\.noAnswer\.has\(info\.id\)[\s\S]*?did not answer, so another model was tried/);
  // Comments stripped first: the explanation above the check quotes
  // "Finished in 22s", which would otherwise be found before the code it
  // describes and make this order check pass or fail for the wrong reason.
  const code = finish.replace(/\/\/.*/g, "");
  const iAbandoned = code.indexOf("noAnswer");
  const iFinished = code.indexOf("Finished in");
  assert.ok(iAbandoned >= 0 && iFinished > iAbandoned, "the abandoned check must come before the 'Finished in' line");
  // And the timed-out turn is retried, even though it carries an abort.
  assert.match(app, /if \(inFlight\?\.timedOut && !gotText\)[\s\S]*?retryOnAnotherModel\(\)/);
});

test("a failure stops counting against a model after half an hour", () => {
  // The free pool's failures are transient. Treating them as permanent had
  // blacklisted ten models on this machine, auto/coding among them - the
  // default the product ships, which answers reliably.
  const app = ui("public", "app.js");
  assert.match(app, /const UNHEALTHY_FOR_MS = 30 \* 60 \* 1000;/);
  assert.match(app, /function recentlyFailed\(key\)[\s\S]*?Date\.now\(\) - rec\.when < UNHEALTHY_FOR_MS/);
  assert.match(app, /Object\.keys\(state\.unhealthy\)\.filter\(recentlyFailed\)/, "the retry ladder only avoids recent failures");
  // The stamp must come from the message, or a re-render would keep an ancient
  // failure looking fresh and it would never age out.
  assert.match(app, /const failedAt = m\.info\?\.time\?\.completed \?\? m\.info\?\.time\?\.created \?\? Date\.now\(\);/);
  assert.match(app, /if \(key && \(state\.unhealthy\[key\]\?\.when \?\? 0\) < failedAt\)/);
});

test("a restored project comes back in its own folder, not the default one", () => {
  // `opencode import` roots the session at the PROCESS CWD and ignores the
  // directory recorded in the file, so with the cwd pinned to the workspace
  // every restored project silently moved there and the next thing the reader
  // asked for was built somewhere they never chose. Verified live 2026-09-02.
  const tr = ui("transcripts.mjs");
  assert.match(tr, /function run\(args, \{ timeoutMs = 60_000, cwd = PATHS\.workspace \} = \{\}\)/, "run takes a cwd");
  assert.ok(!/cwd: PATHS\.workspace,/.test(tr), "the cwd is no longer hard-wired to the workspace");
  assert.match(tr, /\?\.info\?\.directory/, "restore reads the folder recorded in the archive");
  assert.match(tr, /const missing = !!recorded && !fs\.existsSync\(recorded\)/, "a folder that is gone is detected");
  assert.match(tr, /const cwd = recorded && !missing \? recorded : PATHS\.workspace;/, "it restores into that folder, else falls back");
  assert.match(tr, /movedFrom: missing \? recorded : null/, "a fallback is reported, never silent");
  // And the page says where it went.
  const app = ui("public", "app.js");
  assert.match(app, /Restored into your default folder, because \$\{res\.movedFrom\} no longer exists\./);
  assert.match(app, /Restored, working in \$\{baseName\(res\.directory\)\}\./);
});

test("a conversation whose folder is gone says so instead of a bare 500", () => {
  // The agent cannot resolve a deleted working directory and answers HTTP 500
  // "Unexpected server error" for every message forever. The real text also
  // sits at data.data.message, not data.message.
  const app = ui("public", "app.js");
  assert.match(app, /if \(r\.status === 500 && folder\)/, "a 500 is checked against the folder");
  assert.match(app, /api\("folderCheck", \{ query: \{ path: folder \} \}\)/);
  assert.match(app, /The folder this conversation works in is gone: \$\{folder\}/);
  assert.match(app, /r\.data\?\.data\?\.message \?\? r\.data\?\.message/, "the real error text is read from where it actually is");
  assert.ok(Object.hasOwn(routes, "folderCheck"));
});

test("folderCheck answers honestly about a folder", async () => {
  const here = path.join(os.tmpdir(), "omni-agent-folder-check-" + Date.now());
  fs.mkdirSync(here, { recursive: true });
  assert.equal((await routes.folderCheck({ query: { path: here } })).exists, true);
  fs.rmSync(here, { recursive: true, force: true });
  assert.equal((await routes.folderCheck({ query: { path: here } })).exists, false);
  assert.equal((await routes.folderCheck({ query: {} })).exists, false);
});

test("only one copy of the app owns a data directory", () => {
  // Two copies ran two agents against one oc-data and both read-modify-wrote
  // ui-prefs.json, transcripts/index.json and routines.json - so preferences
  // were lost and a scheduled routine could fire twice in the same tick.
  // Measured 2026-09-02: two stacks came up together and each listed the
  // other's conversations.
  const launch = ui("launch.mjs");
  assert.match(launch, /async function runningInstance\(\)/);
  // Liveness is decided by ASKING the port, never by trusting the file: a copy
  // killed from Task Manager leaves its lock behind, and a stale lock must
  // never wedge the app shut.
  assert.match(launch, /fetch\(`http:\/\/127\.0\.0\.1:\$\{lock\.port\}\/instance`/);
  assert.match(launch, /return null; \/\/ nothing answering: the lock is stale/);
  assert.match(launch, /OMNI_AGENT_ALLOW_MULTIPLE/, "there is a documented escape hatch");
  assert.match(launch, /alreadyRunning: true/);
  // Only ever remove OUR lock, or a crashed launch deletes the lock of the
  // copy that replaced it.
  assert.match(launch, /if \(lock\?\.pid === process\.pid\) fs\.unlinkSync/);

  // The lock must NOT carry the UI token: it is a per-launch secret and
  // src/ui/server.mjs states it is never written to disk. That is why the
  // handover goes through /instance instead of handing over a URL.
  assert.match(launch, /JSON\.stringify\(\{ port, pid: process\.pid, startedAt: Date\.now\(\) \}\)/);
  assert.ok(!/uiUrl\(\)[^\n]*writeFileSync/.test(launch), "the token is never written to the lock");

  const server = ui("server.mjs");
  assert.match(server, /if \(p === "\/instance"\)/);
  assert.match(server, /if \(p === "\/instance\/show"\)/);
  // The handshake reveals nothing and cannot drive the agent.
  // Anchored AFTER the instance block starts: `p.startsWith("/oc/")` also
  // appears in the auth guard near the top of the file, so a plain indexOf
  // ends the slice before it begins.
  const instStart = server.indexOf('p === "/instance"');
  const inst = server.slice(instStart, server.indexOf('p.startsWith("/oc/")', instStart));
  assert.ok(!/_token/.test(inst), "the instance handshake never touches the token");
  assert.match(inst, /Date\.now\(\) - _lastShow > 3000/, "showing the window is debounced");

  const bin = fs.readFileSync(pkg("bin", "omni-agent.mjs"), "utf8");
  assert.match(bin, /if \(r\.alreadyRunning\) return process\.exit\(0\);/, "a second copy exits cleanly");
});

test("a bad key can never destroy a connection that already works", () => {
  // 🔴 The loop a reader actually hit: paste a key, be told "not connected",
  // paste again, same thing. Measured 2026-09-02: POST /api/providers for a
  // provider that is ALREADY connected overwrites that connection in place -
  // the identical connection id comes back - and the old "a refused key leaves
  // nothing behind" cleanup then DELETED it. One bad paste, or one transient
  // 401 from the stale-token bug, wiped a working connection and took its
  // models with it.
  const api = ui("api.mjs");
  const add = api.slice(api.indexOf("async providerAdd"), api.indexOf("async providerSignin"));
  // The key is checked with the provider BEFORE the gateway is touched, so a
  // refused key never reaches the destructive write at all.
  const iUpfront = add.indexOf("const upfront = await providers.verifyModelProvider");
  const iAdd = add.indexOf("await providers.addModelProvider");
  assert.ok(iUpfront >= 0 && iUpfront < iAdd, "the key is verified before the gateway is written to");
  assert.match(add, /anything you already had connected is untouched/);
  // And if it still fails later, only a connection THIS call created is removed.
  assert.match(add, /const hadConnection = /);
  assert.match(add, /if \(!hadConnection && r\.connectionId\) \{\s*\n\s*await providers\.removeConnection/);
  assert.match(add, /Your existing connection was left in place/);
});
