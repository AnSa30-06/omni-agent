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
import { GatewayClient } from "../gateway/client.mjs";
import { HttpError } from "../util/http.mjs";
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
  // Which connection each provider is, so the page can offer to remove one.
  // Without this a key that turned out to be wrong, or an account that ran out
  // of credit, could only be cleaned up from the gateway's own dashboard.
  const connectionOf = new Map((conn.connections ?? []).filter((c) => c.provider).map((c) => [c.provider, c.id]));
  const secrets = new Set(listSecretNames());
  const mf = await manifest();

  const models = cat.models.map((p) => ({
    ...p,
    connected: have.has(p.id),
    connectionId: connectionOf.get(p.id) ?? null,
    known: mf ? mf.has(p.id) : null,
  }));
  const signIn = cat.signIn.map((p) => ({
    ...p,
    connected: have.has(p.id),
    connectionId: connectionOf.get(p.id) ?? null,
    known: mf ? mf.has(p.id) : null,
  }));
  const search = cat.search.map((p) => ({ ...p, connected: secrets.has(p.secret) }));

  // Anything connected that this product's curated list does not mention.
  //
  // The gateway can reach 222 providers and the curated list names fifteen, so
  // a connection made from the gateway's own dashboard - or one this product
  // created before the list changed - was invisible here and could not be
  // removed from the app at all. It still contributes models to the picker, so
  // leaving it unlisted meant a provider could be failing every request with no
  // way to see it, let alone turn it off. Measured 2026-09-02: a `deepseek`
  // connection whose account had run out of credit.
  const curated = new Set([...cat.models, ...cat.signIn].map((p) => p.id));
  const others = (conn.connections ?? [])
    .filter((c) => c.provider && !curated.has(c.provider))
    .map((c) => ({ id: c.provider, label: c.provider, connectionId: c.id, connected: true }));

  return { ok: conn.ok, models, signIn, search, others, gatewayReachable: conn.ok, reason: conn.reason };
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
/**
 * Does this key ACTUALLY work?
 *
 * 🔴 The gateway's own `/test` is not an answer. Measured 2026-09-02: a
 * deliberately invalid OpenRouter key (`sk-or-v1-000...0`) was reported
 * `{"valid":true,"diagnosis":{"type":"ok"}}`, and adding it put **1032 models**
 * into the picker that every one of them answers 401 to. So the app said
 * "OpenRouter connected", the model list filled up, and everything failed -
 * which is exactly what people report as "I added my key and it didn't work".
 *
 * ⚠️ Deliberately a DIRECT call to one of the provider's own models, never
 * `complete()`. The fallback chain would answer the probe from some OTHER
 * provider and report a broken key as working - the precise way this check
 * could fool itself.
 *
 * The three outcomes are genuinely different and must not be collapsed:
 *   ok       the key answered - it works
 *   rejected the provider refused the credential (401/403) - the key is wrong
 *   unknown  busy, out of credit, or down (429/5xx/timeout) - NOT the key's fault
 *
 * @param {string[]} modelIds catalogue ids this connection just unlocked
 */
export async function verifyModelProvider(modelIds = []) {
  const candidates = modelIds.filter(Boolean).slice(0, 2);
  if (!candidates.length) {
    return { state: "unknown", reason: "it added no models to try" };
  }
  const client = new GatewayClient();
  let last = null;
  for (const model of candidates) {
    try {
      await client.chat({
        model,
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 1,
        timeoutMs: 45_000,
      });
      return { state: "ok", model };
    } catch (err) {
      last = err;
      const status = err instanceof HttpError ? err.status : null;
      if (status === 401 || status === 403) {
        return {
          state: "rejected",
          status,
          reason: "the provider did not accept that key",
        };
      }
      if (status === 402) {
        return {
          state: "unknown",
          status,
          reason: "the key works but the account has no credit left",
        };
      }
      // Anything else - busy, rate-limited, upstream down - says nothing about
      // the key, so try the next model and then give up without blaming it.
    }
  }
  return {
    state: "unknown",
    reason: `it could not be checked right now (${String(last?.message ?? "no answer").slice(0, 120)})`,
  };
}

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

/**
 * Step-by-step setup for one provider, as lines ready to print.
 *
 * Every search provider that needs a credential carries real steps in the
 * catalogue. They name the page, say what the free tier actually is, and end
 * with the exact command - because "get an API key" is not an instruction to
 * someone who has never done it.
 */
export function setupSteps(id) {
  const cat = catalogue();
  const search = cat.search.find((s) => s.id === id);
  const keyless = (cat.keyless ?? []).find((s) => s.id === id);
  const model = cat.models.find((m) => m.id === id);
  const signIn = cat.signIn.find((m) => m.id === id);

  if (search) {
    return {
      ok: true,
      label: search.label,
      kind: "search",
      gives: search.gives,
      note: search.note,
      steps: search.setup ?? [],
      verify: search.verify ?? null,
    };
  }
  if (keyless) {
    return {
      ok: true,
      label: keyless.label,
      kind: "keyless",
      gives: "Works with no key at all",
      note: keyless.note,
      steps: keyless.setup ?? ["Nothing to set up. This one is already in use."],
      verify: "omni-agent doctor",
    };
  }
  if (model) {
    return {
      ok: true,
      label: model.label,
      kind: model.auth === "oauth" ? "signin" : model.auth === "none" ? "keyless" : "model",
      gives: model.gives,
      note: model.note,
      // A provider's own steps win when it has them: the generic three below say
      // "create a free account" and "copy the API key from their dashboard",
      // which is wrong wherever the account already exists or the credential is
      // called something else.
      steps:
        model.setup ??
        (model.auth === "none"
          ? [`Run:  omni-agent provider add ${id}`, "No account and no key are needed."]
          : model.auth === "oauth"
            ? [`Run:  omni-agent provider signin ${id}`, "Approve the sign-in in the browser it opens."]
            : [
                model.signup ? `Open ${model.signup} and create a free account.` : "Create a free account with the provider.",
                "Copy the API key from their dashboard.",
                `Run:  omni-agent provider add ${id} YOUR-KEY`,
              ]),
      verify: "omni-agent models",
    };
  }
  if (signIn) {
    return {
      ok: true,
      label: signIn.label,
      kind: "signin",
      gives: signIn.gives,
      note: signIn.note,
      steps: [
        `Run:  omni-agent provider signin ${id}`,
        "Approve the sign-in in the browser it opens. Nothing is charged twice.",
      ],
      verify: "omni-agent provider list",
    };
  }
  return { ok: false, reason: `nothing called "${id}" in the catalogue` };
}

export function renderSetup(s) {
  const L = [];
  L.push(`${s.label} - ${s.gives}`);
  if (s.note) L.push(`  ${s.note}`);
  L.push("");
  // Continuation lines (already indented in the catalogue) must not consume a
  // step number, or the list reads 1, 2, 4.
  let n = 0;
  for (const step of s.steps) {
    if (step.startsWith("  ")) L.push(`     ${step.trim()}`);
    else L.push(`  ${++n}. ${step}`);
  }
  if (s.verify) {
    L.push("");
    L.push(`  Check it worked:  ${s.verify}`);
  }
  if (s.kind === "search") {
    L.push("");
    L.push("  Once the key is stored it is used FIRST automatically. You do not");
    L.push("  need to edit any configuration.");
  }
  return L.join("\n");
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
  L.push("  Search already works with NO key: DuckDuckGo, then Brave's public");
  L.push("  page, then public SearXNG instances, then the bundled browser.");
  L.push("  A key below removes the throttling those hit when you search a lot.");
  L.push("");
  for (const p of all.search) {
    L.push(`  ${mark(p.connected)}${p.id.padEnd(15)} ${p.label} - ${p.gives}`);
    L.push(`         sign up: ${p.signup}`);
    if (p.note) L.push(`         ${p.note}`);
  }
  L.push("");
  // No numbers here, on purpose. Two allowances copied from a third-party list
  // were already wrong when checked against the providers' own pages, and a
  // stale figure shown to a non-technical user is worse than no figure.
  L.push("  What each gives is described in kind, not in numbers - allowances change,");
  L.push("  and the signup page is the authority.");
  L.push("");
  L.push("  Step-by-step:   omni-agent provider setup <id>");
  L.push("  Add one with:   omni-agent provider add <id> <key>");
  L.push("  Sign in with:   omni-agent provider signin <id>");
  return L.join("\n");
}
