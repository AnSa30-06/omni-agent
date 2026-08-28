// Verify every signup link in config/providers/free.json actually resolves.
//
// These URLs are shown to a non-technical user as "go here to get your free
// key". A dead one sends them to a 404 and the feature reads as broken, so the
// list is checked rather than trusted.
//
//   node scripts/check-provider-links.mjs
import fs from "node:fs";
import { pkg } from "../src/util/paths.mjs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const say = (s = "") => process.stdout.write(s + "\n");

const cfg = JSON.parse(fs.readFileSync(pkg("config", "providers", "free.json"), "utf8"));
const targets = [];
for (const group of ["models", "search"]) {
  for (const p of cfg[group] ?? []) {
    if (p.signup) targets.push({ group, id: p.id, label: p.label, url: p.signup });
  }
}

say(`Checking ${targets.length} signup link(s)...`);
say("");

let bad = 0;
for (const t of targets) {
  let status = null;
  let note = "";
  // A console that bounces a cookie-less client between its own auth hosts is
  // behind a login, not dead - and this checker used to call that a dead link
  // and get a real provider dropped for it. Measured 2026-08-28 on
  // console.mistral.ai: 302 -> auth.mistral.ai -> v2.auth.mistral.ai -> back,
  // with a new flow id each time, forever. fetch() gives up at 20 hops and
  // reports a bare "fetch failed", which reads exactly like a dead host.
  let loop = false;
  try {
    const res = await fetch(t.url, {
      method: "GET",
      redirect: "follow",
      headers: { "user-agent": UA, accept: "text/html,*/*" },
      signal: AbortSignal.timeout(25_000),
    });
    status = res.status;
    if (res.url && res.url !== t.url) note = `-> ${res.url}`;
  } catch (err) {
    note = err.message;
    const cause = String(err.cause?.message ?? err.cause?.code ?? "");
    if (/redirect count exceeded/i.test(cause + " " + err.message)) {
      loop = true;
      note = "login redirect loop - the host answered, it just will not settle without cookies";
    }
  }
  // 403 from a console behind bot protection is not a dead link; 404 and 5xx are.
  const ok = status !== null && status < 400;
  const tolerated = status === 401 || status === 403 || status === 429 || loop;
  if (!ok && !tolerated) bad++;
  const mark = ok ? "ok  " : tolerated ? "warn" : "FAIL";
  if (loop) status = status ?? "302";
  say(`  ${mark} ${String(status ?? "-").padStart(3)}  ${t.id.padEnd(14)} ${t.url}`);
  if (note) say(`            ${note}`);
}

say("");
if (bad) {
  say(`${bad} link(s) did not resolve. Fix config/providers/free.json before shipping.`);
  process.exit(1);
}
say("Every signup link resolves (401/403/429 and login redirect loops tolerated - those are consoles behind a login).");
