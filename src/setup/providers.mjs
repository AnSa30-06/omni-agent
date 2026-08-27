// Getting more free capacity into the product.
//
// The gateway can reach 222 providers and 90+ of them have a free tier, but a
// fresh install uses none of them: it runs on whatever keyless pool the gateway
// finds, which is slow and rate-limited. Every free key a user adds is more
// headroom, and the whole point of this module is that adding one should take
// a minute and not require understanding what a base URL is.
//
// Three distinct ways in, and they are genuinely different things:
//
//   models   paste a free API key            -> a gateway provider connection
//   signIn   OAuth into a subscription you   -> a gateway provider connection
//            already pay for
//   search   paste a free search key         -> this product's own search stack,
//                                              NOT the gateway
//
// The catalogue in config/providers/free.json is curated; the base URL and auth
// mechanics come from the gateway's own manifest so nothing here goes stale
// when OmniRoute changes a provider.
import fs from "node:fs";
import { admin } from "../gateway/admin.mjs";
import { pkg } from "../util/paths.mjs";
import { setSecret, getSecret, listSecretNames } from "../util/secrets.mjs";
import { gatewayBaseUrl } from "../config.mjs";
import { logger } from "../util/log.mjs";

const log = logger("providers");

let _catalogue = null;
export function catalogue() {
  _catalogue ??= JSON.parse(fs.readFileSync(pkg("config", "providers", "free.json"), "utf8"));
  return _catalogue;
}

let _manifest = null;
/** The gateway's own provider directory, keyed by id. */
export async function manifest() {
  if (_manifest) return _manifest;
  const r = await admin("GET", "/api/v1/provider-plugin-manifest");
  if (!r.ok) return null;
  const list = r.data?.providers ?? [];
  _manifest = new Map(list.map((p) => [p.id, p]));
  return _manifest;
}

/** Provider connections the gateway already has. */
export async function connected() {
  const r = await admin("GET", "/api/providers");
  if (!r.ok) return { ok: false, reason: r.reason, remedy: r.remedy };
  const rows = r.data?.connections ?? [];
  return { ok: true, connections: rows };
}

/**
 * Everything on offer, annotated with whether it is already in place.
 */
export async function listAll() {
  const cat = catalogue();
  const conn = await connected();
  const have = new Set((conn.connections ?? []).map((c) => c.provider));
  const secrets = new Set(listSecretNames());
  const mf = await manifest();

  const models = cat.models.map((p) => ({
    ...p,
    connected: have.has(p.id),
    known: mf ? mf.has(p.id) : null,
  }));
  const signIn = cat.signIn.map((p) => ({
    ...p,
    connected: have.has(p.id),
    known: mf ? mf.has(p.id) : null,
  }));
  const search = cat.search.map((p) => ({ ...p, connected: secrets.has(p.secret) }));
  return { ok: conn.ok, models, signIn, search, gatewayReachable: conn.ok, reason: conn.reason };
}

/**
 * Add a model provider by pasting its key.
 *
 * The base URL comes from the gateway manifest rather than this file - a URL
 * hardcoded here would be one more thing to go stale, and the gateway already
 * knows.
 */
export async function addModelProvider(id, apiKey) {
  const mf = await manifest();
  if (!mf) return { ok: false, reason: "the gateway is not reachable" };
  const entry = mf.get(id);
  if (!entry) return { ok: false, reason: `the gateway does not know a provider called "${id}"` };

  const url = entry.endpoints?.baseUrl;
  if (!url) return { ok: false, reason: `"${id}" publishes no base URL, so it cannot be added this way` };

  const needsKey = entry.auth?.type === "apikey";
  if (needsKey && !apiKey) return { ok: false, reason: `"${id}" needs an API key` };

  const body = { provider: id, name: id, url, isActive: true };
  if (apiKey) body.apiKey = apiKey;
  const r = await admin("POST", "/api/providers", body);
  if (!r.ok) return { ok: false, reason: r.reason, detail: r.data };

  const created = r.data?.id ?? r.data?.connection?.id ?? null;
  log.info("added provider", { id, hasKey: !!apiKey });
  return { ok: true, id, connectionId: created };
}

/** Ask the gateway to make a real call against a connection. */
export async function testConnection(connectionId) {
  const r = await admin("POST", `/api/providers/${connectionId}/test`);
  if (!r.ok) return { ok: false, reason: r.reason, detail: r.data };
  const d = r.data ?? {};
  // The endpoint reports its own verdict; treat anything but an explicit pass
  // as a failure rather than assuming HTTP 200 means the key works.
  const passed = d.ok === true || d.success === true || d.status === "ok" || d.valid === true;
  // The gateway distinguishes "your credential is wrong" from "their server is
  // down", and the remedy is completely different. Telling someone to check a
  // key they never entered is worse than saying nothing.
  const kind = d.diagnosis?.type ?? null;
  const upstream = kind === "upstream_unavailable" || /timed out|ECONN|ENOTFOUND|unavailable/i.test(d.error ?? "");
  return {
    ok: passed,
    upstream,
    kind,
    error: d.error ?? null,
    remedy: passed
      ? null
      : upstream
        ? "That is the provider's own server, not your credential. It is saved; try again later."
        : "The gateway rejected the credential. Check it and re-add.",
    detail: d,
  };
}

export async function removeConnection(connectionId) {
  const r = await admin("DELETE", `/api/providers/${connectionId}`);
  return r.ok ? { ok: true } : { ok: false, reason: r.reason };
}

/**
 * Where to send someone to sign in to a subscription they already hold.
 *
 * This returns a URL for the user to open themselves. It deliberately does not
 * drive the flow: an OAuth consent screen is the user's decision to make, and
 * this program has no business clicking through one on their behalf.
 */
export async function signInUrl(id) {
  const mf = await manifest();
  const entry = mf?.get(id);
  if (!entry) return { ok: false, reason: `the gateway does not know a provider called "${id}"` };
  const oauth = entry.auth?.type === "oauth" || (entry.capabilities ?? []).includes("oauth");
  if (!oauth) return { ok: false, reason: `"${id}" does not support signing in; it needs an API key` };
  return { ok: true, url: `${gatewayBaseUrl()}/api/oauth/${id}/authorize` };
}

/** Whether a sign-in has actually completed. */
export async function signInStatus(id) {
  const r = await admin("GET", `/api/oauth/${id}/status`);
  return r.ok ? { ok: true, status: r.data } : { ok: false, reason: r.reason };
}

/** Store a search-provider key locally. These never go near the gateway. */
export function addSearchKey(id, key) {
  const entry = catalogue().search.find((s) => s.id === id);
  if (!entry) return { ok: false, reason: `unknown search provider "${id}"` };
  if (!key) return { ok: false, reason: "no key supplied" };
  setSecret(entry.secret, key);
  log.info("stored search key", { id });
  return { ok: true, id, secret: entry.secret };
}

export function hasSearchKey(id) {
  const entry = catalogue().search.find((s) => s.id === id);
  return entry ? !!getSecret(entry.secret) : false;
}

/** Render the whole picture for a terminal. */
export function render(all) {
  const L = [];
  const mark = (on) => (on ? "[on] " : "[  ] ");

  L.push("FREE CAPACITY");
  L.push("");
  L.push("  Models - paste a free key, get more and faster models");
  L.push("");
  for (const p of all.models) {
    L.push(`  ${mark(p.connected)}${p.id.padEnd(15)} ${p.label}`);
    L.push(`         ${p.gives}`);
    if (p.signup) L.push(`         sign up: ${p.signup}`);
    if (p.note) L.push(`         ${p.note}`);
    L.push("");
  }

  L.push("  Sign in - use a subscription you already pay for");
  L.push("");
  for (const p of all.signIn) {
    L.push(`  ${mark(p.connected)}${p.id.padEnd(15)} ${p.label} - ${p.gives}${p.note ? ` (${p.note})` : ""}`);
  }
  L.push("");

  L.push("  Web search - removes the throttling that keyless search hits");
  L.push("");
  for (const p of all.search) {
    L.push(`  ${mark(p.connected)}${p.id.padEnd(15)} ${p.label} - ${p.gives}`);
    L.push(`         sign up: ${p.signup}`);
    if (p.note) L.push(`         ${p.note}`);
  }
  L.push("");
  L.push('  "gives" is each provider\'s own advertised allowance, not a measurement.');
  L.push("");
  L.push("  Add one with:   omni-agent provider add <id> <key>");
  L.push("  Sign in with:   omni-agent provider signin <id>");
  return L.join("\n");
}
