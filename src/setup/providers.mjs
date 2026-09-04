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

let _keyless = null;
/**
 * Keyless vendors that were MEASURED not to answer, keyed by vendor prefix.
 *
 * 🔴 Why this file exists. The gateway advertises ~120 models that need no key
 * at all, and it publishes no health for any of them: `tllm` reports
 * `active: true` and then answers HTTP 403 because its host blocks the request.
 * Measured 2026-09-03, most of that pool could not complete a one-word prompt
 * from any of their models. Offering them anyway is what got reported as "all
 * the models in the free list are screwed" - a reader has no way to tell a
 * model that is momentarily busy from one that has never worked at all.
 *
 * ⚠️ This is a MEASUREMENT WITH A DATE, not a permanent judgement. A vendor can
 * come back. `scripts/check-keyless-health.mjs` re-measures and prints what has
 * changed; the app hides these models but always offers a way to see them.
 */
export function keylessHealth() {
  if (_keyless) return _keyless;
  let doc = { broken: [] };
  try {
    doc = JSON.parse(fs.readFileSync(pkg("config", "providers", "keyless-health.json"), "utf8"));
  } catch (err) {
    log.warn("keyless-health.json could not be read: %s", err.message);
  }
  _keyless = new Map((doc.broken ?? []).map((b) => [String(b.vendor).toLowerCase(), b]));
  return _keyless;
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

  // 🔴 `connected` is only MEANINGFUL when the gateway actually answered.
  //
  // When it does not - it was down, its database was damaged, its credentials
  // had gone stale - `have` is empty and every provider rendered as "not
  // connected". That is a lie, and an expensive one: measured 2026-09-02, a
  // corrupt gateway database showed a reader "not connected" beside a key that
  // was connected and working, and sent us both hunting the key for hours. When
  // the answer is unknown the page must say so, so `connected` is null rather
  // than false.
  const decorate = (p) => ({
    ...p,
    connected: conn.ok ? have.has(p.id) : null,
    connectionId: connectionOf.get(p.id) ?? null,
    known: mf ? mf.has(p.id) : null,
  });
  const models = cat.models.map(decorate);
  const signIn = cat.signIn.map(decorate);
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
/**
 * The header a provider wants its key in.
 *
 * Not every provider takes `Authorization: Bearer`. The gateway's manifest
 * declares which, and using the wrong one turns a good key into a 401 - a
 * false accusation, which is the worst answer this check can give.
 * Measured 2026-09-02 across all 13 key providers: bearer for most, `x-api-key`
 * for zai, `x-goog-api-key` for gemini.
 */
function authHeaders(entry, apiKey) {
  const declared = String(entry?.auth?.header ?? "bearer").toLowerCase();
  const base = { accept: "application/json" };
  if (declared === "bearer" || declared === "authorization") {
    return { ...base, authorization: `Bearer ${apiKey}` };
  }
  // A named header, e.g. x-api-key or x-goog-api-key.
  return { ...base, [declared]: apiKey };
}

/**
 * Does this refusal blame the CREDENTIAL, or the model?
 *
 * 🔴 The bug this exists for, and it condemned a perfectly good key. Measured
 * 2026-09-04: the first two models in OpenRouter's own catalogue are
 * `meta/muse-spark-1.3-contributor` and `meta/muse-spark-1.3`, and both answer
 * HTTP 403 - *"This model requires you to complete the following before use:
 * 18+ age confirmation"*. The third, `google/gemini-3.8-flash`, answers 200 on
 * the SAME key. Treating any 403 as "the key is bad" stopped at the first one,
 * so a working key was reported as refused because of the order of somebody
 * else's list.
 *
 * 401 is unambiguous: it is always the credential. 403 means "you may not do
 * this", which covers a bad key AND a model you have not unlocked, a region
 * block, a moderation gate. So a 403 only condemns the key when the provider
 * says so in words.
 */
export function blamesTheKey(status, body) {
  if (status === 401) return true;
  if (status !== 403) return false;
  const text = String(body ?? "");
  if (/\bmodel\b[^.]{0,80}\b(requires|restricted|not available|unavailable|access)/i.test(text)) return false;
  if (/age confirmation|moderation|region|country|privacy policy|data policy/i.test(text)) return false;
  return /api.?key|unauthor|invalid.*(credential|token)|no auth|credential|forbidden/i.test(text);
}

/**
 * Ask the PROVIDER whether the key is good, without going through the gateway.
 *
 * ⭐ Why not through the gateway: measured 2026-09-02 with a key that was
 * provably working, probing through it answered 404 "only available through the
 * Batch API" and then 502, because some catalogue ids are batch-only serving
 * modes and the gateway caches ONE upstream failure and replays it for other
 * models for up to ~90 s. A perfect key reported "could not be checked".
 *
 * 🔴 AND WHY A MODEL LIST IS NEVER THE PROOF. `GET {root}/models` looks like an
 * authentication check. Measured with a deliberately fake key across all 13 key
 * providers: EIGHT correctly answer 401, but FOUR serve it publicly and
 * answered 200 - openrouter, nvidia, requesty and opencode-zen - and
 * cloudflare-ai 404s because its API is not OpenAI-shaped at all. A version of
 * this that trusted the listing shipped for ten minutes and called
 * `sk-or-v1-` + 48 zeros "ok". So the listing may only ever CONDEMN a key
 * (401/403) or supply model names; proof of life is a completion.
 *
 * @returns {"ok"|"rejected"|"unknown"}
 */
async function askProviderDirectly(id, apiKey) {
  if (!apiKey || !id) return "unknown";
  const mf = await manifest();
  const entry = mf?.get(id);
  const base = entry?.endpoints?.baseUrl;
  if (!base) return "unknown";
  // ⚠️ A provider's declared base URL is not always the completions endpoint.
  // Measured 2026-09-03: gemini declares
  // `https://generativelanguage.googleapis.com/v1beta/models` - the listing
  // itself. Stripping only `/chat/completions` left the root one segment too
  // deep, every probe 404d, and gemini could never be checked at all.
  const root = base.replace(/\/chat\/completions\/?$/, "").replace(/\/models\/?$/, "");
  if (!/^https:\/\//i.test(root)) return "unknown";
  const H = authHeaders(entry, apiKey);

  // The listing, asked TWICE: once with the key and once with nothing at all.
  //
  // ⭐ The second call is what makes a listing usable as proof. On its own a
  // 200 means nothing - measured across all 13 key providers, four serve their
  // catalogue publicly (openrouter, nvidia, requesty, opencode-zen), which is
  // how `sk-or-v1-` + 48 zeros once came back "ok". But if the SAME request
  // without a key is refused and with the key succeeds, the key opened a door
  // that is shut without it. That is real evidence, and it is the only evidence
  // available for a provider that is not OpenAI-shaped.
  const get = async (headers) => {
    try {
      const r = await fetch(`${root}/models`, { headers, signal: AbortSignal.timeout(20_000) });
      return { status: r.status, body: r };
    } catch {
      return { status: 0, body: null }; // unreachable says nothing about the key
    }
  };
  const [mine, anon] = await Promise.all([get(H), get({ accept: "application/json" })]);
  if (mine.status === 0) return "unknown";
  if (mine.status === 401) return "rejected";
  // A 403 on the LISTING is far more likely to be about the key than a 403 on
  // one model, but it can still be a region block, so it is read the same way.
  if (mine.status === 403 && blamesTheKey(403, await mine.body.text().catch(() => ""))) return "rejected";

  const gated = anon.status === 401 || anon.status === 403;
  if (gated) {
    if (mine.status === 200) return "ok";
    // A gated listing that answers 400 to our key is usually saying the key is
    // wrong - gemini replies 400 "API key not valid". But 400 also means a
    // malformed request, and calling a GOOD key invalid is the worst answer
    // this check can give, so the body has to actually say so.
    if (mine.status === 400) {
      const text = await mine.body.text().catch(() => "");
      if (/api.?key|unauthor|invalid.*(credential|token)|credential/i.test(text)) return "rejected";
    }
  }

  // Public listing, or a shape we do not recognise. Model names only.
  let models = [];
  if (mine.status === 200) {
    const d = await mine.body.json().catch(() => null);
    models = (d?.data ?? d?.models ?? [])
      .map((m) => (typeof m === "string" ? m : m?.id ?? m?.name))
      .filter((x) => typeof x === "string" && !/:(batch|thinking|extended|online|preview)$/i.test(x));
  }

  // 2. Proof of life. Needs the credential, so a public endpoint cannot fake
  //    it. Several models are tried because any one of them may be retired,
  //    gated, out of capacity, or age-restricted without the key being at
  //    fault - and FIVE rather than three, because OpenRouter's list opens with
  //    two age-gated models and three tries only just reached a usable one.
  for (const model of models.slice(0, 5)) {
    try {
      const r = await fetch(`${root}/chat/completions`, {
        method: "POST",
        headers: { ...H, "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
        signal: AbortSignal.timeout(45_000),
      });
      if (r.ok) return "ok";
      if (r.status === 401 || r.status === 403) {
        // Only a refusal that names the CREDENTIAL ends this. One that blames
        // the model means try another model - see blamesTheKey().
        const body = await r.text().catch(() => "");
        if (blamesTheKey(r.status, body)) return "rejected";
      }
      // 402 no credit, 404 model not servable, 429 busy: inconclusive, next.
    } catch {
      return "unknown";
    }
  }
  return "unknown";
}

export async function verifyModelProvider(modelIds = [], id = null, apiKey = null) {
  // The provider's own answer first: it is faster, cheaper and not subject to
  // the gateway's routing or its backoff.
  if (id) {
    const direct = await askProviderDirectly(id, apiKey);
    if (direct === "ok") return { state: "ok", how: "the provider accepted the key" };
    if (direct === "rejected") return { state: "rejected", reason: "the provider did not accept that key" };
  }

  // WHICH models to try on, and it decides whether a good key is believed.
  //
  // Measured 2026-09-02 with a working OpenRouter key: the first two ids in
  // catalogue order were batch-only models, which answer
  // "[404]: This model is only available through the Batch API", so the check
  // gave up and reported "could not be checked" for a key that was perfect.
  // Worse, the gateway caches one upstream failure and replays it for OTHER
  // models for up to ~90 s, so consecutive tries can all inherit one bad
  // answer. Both problems are fixed the same way: prefer ordinary chat models,
  // and try enough of them to get past a poisoned one.
  const plain = (id) => !/:(batch|thinking|extended|online|preview)$/i.test(id);
  const ranked = modelIds.filter(Boolean).sort((a, b) => {
    // A plain `vendor/model` id with no suffix is the likeliest ordinary chat
    // model; a suffixed variant is likeliest to be a special serving mode.
    const score = (x) => (plain(x) ? 0 : 1) + (/:free$/i.test(x) ? 0 : 0);
    return score(a) - score(b);
  });
  const candidates = ranked.slice(0, 6);
  if (!candidates.length) {
    return { state: "unknown", reason: "it added no models to try" };
  }
  const client = new GatewayClient();
  // ⚠️ A wall-clock budget, because six models at 45 s each is four and a half
  // minutes of a reader watching a spinner. Measured 2026-09-03: adding a key
  // for cloudflare-ai took 64.8 s to conclude nothing, because every model it
  // contributed answered 502 and a 502 is inconclusive, so the loop kept going.
  // The direct probe above settles almost every provider in under 1.5 s; this
  // is the fallback, and a fallback that runs for a minute is its own defect.
  const deadline = Date.now() + 30_000;
  let last = null;
  for (const model of candidates) {
    if (Date.now() > deadline && last) break;
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
      // Anything else - busy, rate-limited, upstream down, a model that is not
      // servable this way - says nothing about the key. Try the next model and
      // then give up without blaming it.
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
/**
 * Turn a CLI step into what to do on the page you are already looking at.
 *
 * The steps are written for the terminal, and in the app they were shown
 * verbatim - so the "How?" button told someone who has never opened a terminal
 * to `Run: omni-agent provider add openrouter YOUR-KEY`, directly above a box
 * that already takes the key. That is the whole "I didn't know how to add it"
 * half of the problem.
 */
function forTheApp(steps, kind) {
  const inApp =
    kind === "signin"
      ? "Press Sign in on this page and approve it in the browser window that opens."
      : "Paste the key into the box on this page and press Add.";
  const out = [];
  for (const step of steps) {
    const text = String(step);
    // Any step whose whole job is the CLI command becomes the in-app action.
    if (/Run:\s*omni-agent provider (add|signin)/i.test(text)) {
      if (!out.includes(inApp)) out.push(inApp);
      continue;
    }
    out.push(text);
  }
  if (!out.includes(inApp)) out.push(inApp);
  return out;
}

/**
 * @param {string} id
 * @param {{context?: "cli"|"app"}} [opts] "app" rewrites the terminal steps
 *   into the buttons that are on screen.
 */
export function setupSteps(id, opts = {}) {
  const inApp = opts.context === "app";
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
      steps: inApp ? forTheApp(search.setup ?? [], "search") : (search.setup ?? []),
      verify: inApp ? "The app tries a real search with it and tells you what happened." : (search.verify ?? null),
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
      steps: (inApp ? (x) => forTheApp(x, model.auth === "oauth" ? "signin" : "model") : (x) => x)(
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
      ),
      verify: inApp
        ? "The app tries the key on a real model and tells you if it was accepted."
        : "omni-agent models",
    };
  }
  if (signIn) {
    return {
      ok: true,
      label: signIn.label,
      kind: "signin",
      gives: signIn.gives,
      note: signIn.note,
      steps: (inApp ? (x) => forTheApp(x, "signin") : (x) => x)([
        `Run:  omni-agent provider signin ${id}`,
        "Approve the sign-in in the browser it opens. Nothing is charged twice.",
      ]),
      verify: inApp ? "This page shows it as connected once it works." : "omni-agent provider list",
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
