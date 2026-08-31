// Everything the UI can do that OpenCode cannot.
//
// OpenCode's own server covers sessions, messages, agents, models and
// permissions. This file covers the other half of the product: the model
// gateway, the token-saving ladder, free-provider onboarding, the search
// stack, settings, the transcript archive, routines, and the dashboard.
//
// Each route is a plain function of ({body, query, method}) returning JSON.
// They are looked up in an explicit table, never built from the request path,
// so a malformed URL is a 404 rather than a call to something unintended.
import { admin, dashboardPassword } from "../gateway/admin.mjs";
import { gatewayBaseUrl, loadConfig, updateConfig, DEFAULTS } from "../config.mjs";
import { writeOpenCodeConfig } from "../setup/opencode-config.mjs";
import { applyConfig } from "../setup/apply-config.mjs";
import { clearCache as clearCatalogueCache } from "../routing/catalog.mjs";
import { logger } from "../util/log.mjs";
import { status as gatewayStatus } from "../gateway/supervisor.mjs";
import { PAGES, dashboardUrl, openInBrowser } from "../gateway/dashboard.mjs";
import { TIERS, getSaving, setSaving, measure, ALWAYS_PRESERVED } from "../routing/compression.mjs";
import * as providers from "../setup/providers.mjs";
import { availableProviders } from "../tools/search.mjs";
import { listSecretNames } from "../util/secrets.mjs";
import { oc, credentials } from "./opencode-server.mjs";
import * as transcripts from "./transcripts.mjs";
import * as routines from "./routines.mjs";
import { readPrefs, writePrefs } from "./prefs.mjs";
import { PATHS } from "../util/paths.mjs";
import { pkg } from "../util/paths.mjs";
import fs from "node:fs";
import path from "node:path";

/* -- Windows file and folder dialogs -------------------------------------
 *
 * THE BUG THESE EXIST TO FIX, and the first version's comment claimed the fix
 * while the code did not implement it: a WinForms dialog shown from a process
 * that has never had foreground opens BEHIND the app. The button says "waiting
 * for the folder picker..." forever, the user clicks again, and each click
 * stacks another invisible dialog. Measured 2026-08-28 against the shipped
 * 1.1.2: three orphaned "Browse For Folder" windows sitting behind the app.
 *
 * What fixes it is an owner window that EXISTS - see the note on DIALOG_OWNER
 * for what "exists" has to mean here, because the obvious way to make one
 * (Show it) breaks the dialog outright.
 *
 * And only ever one at a time. Without the guard a second click is a second
 * dialog, and that pile-up is what made a window in the wrong place look like a
 * freeze.
 */

// The owner is a real window, parked off-screen at 1x1, that is never SHOWN.
//
// 🔴 `$owner.Show()` is the trap, and it is a worse bug than the one it was
// meant to fix. The picker is spawned with `windowsHide: true`, which starts
// the process with a one-shot SW_HIDE that Windows applies to the first window
// the process shows - so Show() consumes it on the owner, the owner is hidden,
// and the dialog it owns is hidden with it. Measured 2026-08-28: with Show()
// the child exits code 0 in under a second, prints nothing, and the app reports
// a cancelled picker that the user never saw.
//
// ⭐ Touching `.Handle` creates the window WITHOUT calling ShowWindow, so the
// SW_HIDE is never spent and the dialog opens normally - measured at z-order 3
// of 17 with the app window at 17, i.e. comfortably in front. `Form.TopMost` is
// left off deliberately: it is a no-op on a form that was never shown, and
// SetWindowPos(HWND_TOPMOST) on the owner was measured to change nothing about
// where the dialog lands. It is in front; it does not need to outrank
// everything on the desktop.
const DIALOG_OWNER = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "$owner = New-Object System.Windows.Forms.Form",
  "$owner.ShowInTaskbar = $false",
  "$owner.FormBorderStyle = 'None'",
  "$owner.StartPosition = 'Manual'",
  "$owner.Location = New-Object System.Drawing.Point(-32000, -32000)",
  "$owner.Size = New-Object System.Drawing.Size(1, 1)",
  "$null = $owner.Handle",
];

const FOLDER_DIALOG = [
  ...DIALOG_OWNER,
  "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
  "$d.Description = 'Choose the folder Omni Agent should work in'",
  "$d.ShowNewFolderButton = $true",
  "if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }",
  "$owner.Dispose()",
].join("; ");

const FILE_DIALOG = [
  ...DIALOG_OWNER,
  "$d = New-Object System.Windows.Forms.OpenFileDialog",
  "$d.Title = 'Choose files to give the agent'",
  "$d.Multiselect = $true",
  "if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileNames | ForEach-Object { Write-Output $_ } }",
  "$owner.Dispose()",
].join("; ");

// Every model id the agent can currently see, as `providerID/modelID`. Used
// to report what a newly added key actually unlocked.
async function modelIds() {
  const r = await oc("GET", "/config/providers");
  if (!r.ok) return new Set();
  const all = r.data?.providers ?? r.data?.all ?? r.data?.data ?? [];
  const out = new Set();
  for (const p of Array.isArray(all) ? all : []) {
    for (const id of Object.keys(p.models ?? {})) out.add(`${p.id}/${id}`);
  }
  return out;
}

/**
 * Everything that has to happen after the set of connected providers changes.
 *
 * This is the fix for "I pasted my API key and the models were never used". Adding a
 * provider used to touch the gateway and stop there, which left two stale things behind:
 *
 *   1. the routing catalogue, cached for five minutes and never invalidated - so
 *      `selectModel` kept ranking against a model list that predated the new key;
 *   2. `opencode.json`, whose pinned model is resolved ONCE at launch by `applyConfig()`.
 *      Nothing rewrote it, so the agent went on running the model it picked at startup
 *      no matter what was connected afterwards.
 *
 * `clearCache` had existed for exactly this purpose since the catalogue was written and
 * had never had a single caller.
 */
const apiLog = logger("ui-api");

async function providersChanged() {
  clearCatalogueCache();
  try {
    const applied = await applyConfig();
    return { rewired: true, model: applied.model };
  } catch (err) {
    // A failure here is not a reason to report the key as unsaved - it IS saved. Say what
    // did and did not happen instead of collapsing both into one verdict.
    apiLog.warn("provider added but the agent config could not be rewritten", { err: err.message });
    return { rewired: false, model: null, problem: err.message };
  }
}

/** One dialog at a time, across every kind. See the note above. */
let dialogOpen = false;

async function showDialog(script) {
  if (process.platform !== "win32") return bad("the picker is Windows-only; type a path instead");
  if (dialogOpen) return bad("a picker is already open - finish or cancel it first");
  dialogOpen = true;
  try {
    // Asynchronously, and that is not a style choice: the dialog stays open for
    // as long as the user browses, and execFileSync would block this server's
    // event loop for all of it - the app would freeze mid-click.
    const { spawn } = await import("node:child_process");
    const out = await new Promise((resolve) => {
      // -STA because both dialogs need a single-threaded apartment.
      const child = spawn("powershell.exe", ["-NoProfile", "-STA", "-Command", script], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      let buf = "";
      child.stdout.on("data", (b) => (buf += b.toString()));
      child.on("error", () => resolve(null));
      child.on("close", () => resolve(buf));
    });
    if (out === null) return bad("the picker could not open");
    const paths = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return paths.length ? { ok: true, paths } : { ok: true, cancelled: true };
  } finally {
    dialogOpen = false;
  }
}

/**
 * How a chosen file should reach the model.
 *
 * Measured 2026-08-28, not assumed: a `file` part carrying `url: file://<path>`
 * and a text mime puts the file's CONTENTS in front of the model with no tool
 * call at all - a probe file was answered from an 11,350-token prompt while the
 * agent was explicitly told not to use tools.
 *
 * Anything that is not text is offered as a PATH instead, for the agent's own
 * readers to open. The product ships PDF/DOCX/XLSX readers and a browser, the
 * free models it defaults to are mostly not vision models, and a binary pushed
 * at a model that cannot take one fails the whole turn. A path always works.
 */
const TEXT_MIME = {
  ".txt": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown",
  ".json": "application/json", ".jsonl": "application/json", ".csv": "text/csv",
  ".tsv": "text/tab-separated-values", ".xml": "text/xml", ".yml": "text/yaml",
  ".yaml": "text/yaml", ".toml": "text/plain", ".ini": "text/plain",
  ".log": "text/plain", ".sql": "text/plain", ".html": "text/html",
  ".htm": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".mjs": "text/javascript", ".cjs": "text/javascript", ".jsx": "text/javascript",
  ".ts": "text/plain", ".tsx": "text/plain", ".py": "text/x-python",
  ".rb": "text/plain", ".go": "text/plain", ".rs": "text/plain",
  ".java": "text/plain", ".c": "text/plain", ".h": "text/plain",
  ".cpp": "text/plain", ".cs": "text/plain", ".sh": "text/plain",
  ".bat": "text/plain", ".cmd": "text/plain", ".ps1": "text/plain",
};

// Big text files are offered as a path too. The whole file goes into the prompt
// otherwise, and one large log would spend the context window on message one.
const INLINE_LIMIT = 256 * 1024;

function describeFile(full) {
  let stat = null;
  try {
    stat = fs.statSync(full);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const mime = TEXT_MIME[path.extname(full).toLowerCase()] ?? null;
  const inline = Boolean(mime) && stat.size <= INLINE_LIMIT;
  return {
    path: full,
    name: path.basename(full),
    size: stat.size,
    mime: mime ?? "application/octet-stream",
    // The client uses this to choose between a file part and a mentioned path.
    inline,
    why: inline
      ? "sent with your message"
      : mime
        ? "too big to send inline, so the agent will open it"
        : "the agent will open this one itself",
  };
}

const ok = (d = {}) => ({ ok: true, ...d });
const bad = (reason, extra = {}) => ({ ok: false, error: reason, ...extra });


/** Read a number out of whichever field a provider happened to use. */
function firstNumber(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

export const routes = {
  // --- state ---------------------------------------------------------------

  async status() {
    const gw = gatewayStatus();
    const agent = credentials();
    const health = agent ? await oc("GET", "/api/health") : { ok: false };
    let version = null;
    try {
      version = JSON.parse(fs.readFileSync(pkg("package.json"), "utf8")).version;
    } catch {}
    return ok({
      version,
      gateway: { running: gw.running, pid: gw.pid, baseUrl: gatewayBaseUrl() },
      agent: { running: !!agent, healthy: health.ok === true },
      home: PATHS.home,
      workspace: PATHS.workspace,
    });
  },

  /**
   * Every model the user can actually pick, grouped by provider.
   *
   * This reads /config/providers, NOT /api/model. Measured 2026-08-27:
   * /api/model returns OpenCode's static catalogue - 7,329 models from 200-odd
   * vendors, almost none of which this install can reach - and it does not
   * contain plugin-registered providers at all, so the gateway's own 81 models
   * were missing from it entirely. /config/providers returns what is
   * configured and reachable, which is the only list worth showing.
   */
  async models() {
    const r = await oc("GET", "/config/providers");
    if (!r.ok) return bad(r.reason);
    const all = r.data?.providers ?? r.data?.all ?? r.data?.data ?? [];
    const defaults = r.data?.default ?? {};
    // Which upstreams are here because the reader added a key. The gateway's
    // own connection list is the authority and cost is NOT: a free-tier key
    // like Mistral's serves at zero cost, so the first version of this - "costs
    // money means a key paid for it" - filed every free-tier key's models under
    // Free and left "From your keys" answering a question nobody asked. When
    // the gateway will not answer, this is empty and the UI says the list is
    // incomplete rather than guessing.
    const conn = await providers.connected();
    // A model id's first segment is the provider's ALIAS, and 109 of the
    // gateway's 222 providers publish an alias that is not their id -
    // `github-models` serves `ghm/...`, `duckduckgo-web` serves `ddgw/...`.
    // Matching a connection's provider id against the prefix alone would
    // therefore miss half of them, so both spellings go in the set.
    const mf = await providers.manifest();
    const keyed = new Set();
    for (const c of conn.connections ?? []) {
      const id = String(c.provider ?? "").trim();
      if (!id) continue;
      keyed.add(id.toLowerCase());
      const alias = mf?.get(id)?.alias;
      if (alias) keyed.add(String(alias).toLowerCase());
    }

    const groups = (Array.isArray(all) ? all : []).map((p) => ({
      id: p.id,
      name: p.name ?? p.id,
      // The gateway is this product's own provider; it goes first.
      preferred: p.id === "opencode-omniroute",
      default: defaults[p.id] ?? null,
      models: Object.entries(p.models ?? {})
        .map(([id, m]) => {
          // The upstream the gateway is routing to, taken from the model id's
          // first segment (`oc/hy3-free` -> `oc`, `mistral/mistral-large` ->
          // `mistral`). Every model the gateway serves arrives under ONE
          // provider id, so without this there is no way to tell a keyless
          // model from one that only exists because the reader added a key -
          // which is exactly the question "which models did my key give me?"
          const vendor = id.includes("/") ? id.slice(0, id.indexOf("/")) : null;
          const free = (m.cost?.input ?? 0) === 0 && (m.cost?.output ?? 0) === 0;
          return {
            id,
            name: m.name ?? id,
            vendor,
            context: m.limit?.context ?? null,
            output: m.limit?.output ?? null,
            free,
            // Two independent ways to be certain a key is what put this model
            // in the list: its upstream is a connection the reader made, or it
            // costs money and so cannot be part of the keyless pool.
            fromKey: (vendor !== null && keyed.has(vendor.toLowerCase())) || !free,
            reasoning: !!m.reasoning,
            attachments: !!m.attachment,
            // Some providers list image and audio generators beside their chat
            // models. They are real models and they cannot hold a conversation,
            // so they must never be offered as a default: the gateway's own
            // published default here is `pollinations/zimage`, an image model,
            // which is what the picker landed on before this filter existed.
            textOut: m.modalities?.output?.text !== false,
          };
        })
        .filter((m) => m.textOut),
    }));
    groups.sort((a, b) => Number(b.preferred) - Number(a.preferred) || a.id.localeCompare(b.id));

    // What the product itself configured OpenCode to use. This is the honest
    // default - it is the routing combo the setup wizard chose.
    const cfg = await oc("GET", "/config");
    const pin = typeof cfg.data?.model === "string" ? cfg.data.model : null;
    let configured = null;
    if (pin) {
      const i = pin.indexOf("/");
      // Field name matters: OpenCode's ModelRef is {providerID, id}.
      if (i > 0) configured = { providerID: pin.slice(0, i), id: pin.slice(i + 1) };
    }
    return ok({
      providers: groups,
      configured,
      total: groups.reduce((n, g) => n + g.models.length, 0),
      // The connections themselves, so the UI can tell "you have added no keys"
      // apart from "the gateway did not answer and this may be wrong".
      connections: (conn.connections ?? []).map((c) => c.provider).filter(Boolean),
      connectionsKnown: conn.ok === true,
    });
  },

  /**
   * Usage, as percentages where a percentage is real.
   *
   * Two different things are reported and they are never blended:
   *   context  how full the running conversation is. Computed here from the
   *            session's own token counts against the model's stated limit.
   *   quota    the provider's free allowance. Comes from the gateway, which
   *            gets it from the provider. Providers that publish no quota API
   *            report "unavailable" - this never estimates one.
   */
  async usage({ query }) {
    const out = { context: null, quota: null, spend: null, notes: [] };

    if (query.session) {
      const s = await oc("GET", `/api/session/${query.session}`);
      const m = await oc("GET", "/config/providers");
      if (s.ok) {
        const sess = s.data?.data ?? s.data;
        const t = sess?.tokens ?? {};
        const used = (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
        let limit = null;
        if (m.ok) {
          const providerID = sess?.model?.providerID;
          const modelID = sess?.model?.id ?? sess?.model?.modelID;
          const all = m.data?.providers ?? m.data?.all ?? m.data?.data ?? [];
          const p = (Array.isArray(all) ? all : []).find((x) => x.id === providerID);
          limit = firstNumber(p?.models?.[modelID]?.limit ?? {}, ["context", "contextWindow"]);
        }
        out.context = {
          used,
          limit,
          percent: limit ? Math.min(100, Math.round((used / limit) * 100)) : null,
          cost: sess?.cost ?? 0,
        };
        if (!limit) out.notes.push("This model does not publish a context limit, so there is no percentage to show.");
      }
    }

    const an = await admin("GET", "/api/usage/analytics");
    if (an.ok) out.spend = an.data?.summary ?? null;

    const q = await admin("GET", "/api/quota/plans");
    if (q.ok) {
      const plans = Array.isArray(q.data) ? q.data : (q.data?.plans ?? q.data?.data ?? []);
      out.quota = (Array.isArray(plans) ? plans : []).map((p) => {
        const used = firstNumber(p, ["used", "usedRequests", "consumed"]);
        const total = firstNumber(p, ["limit", "total", "quota", "maxRequests"]);
        return {
          provider: p.provider ?? p.id ?? p.name ?? "unknown",
          used,
          total,
          // No total means the provider does not tell us. Say so; never guess.
          percent: used != null && total ? Math.min(100, Math.round((used / total) * 100)) : null,
          available: used != null && total != null,
        };
      });
      if (out.quota.some((r) => !r.available)) {
        out.notes.push("Providers that do not publish an allowance show as Unavailable rather than an estimate.");
      }
    } else {
      out.notes.push("The gateway did not return quota information.");
    }
    return ok(out);
  },

  // --- token saving --------------------------------------------------------

  async savingList() {
    const cur = await getSaving();
    const m = await measure();
    const rows = (m.results ?? TIERS).map((t) => ({
      id: t.id,
      label: t.label,
      axis: t.axis,
      summary: t.summary,
      costs: t.costs,
      published: t.published,
      savedPct: t.measured ? t.savedPct : null,
    }));
    return ok({
      tiers: rows,
      current: cur.ok ? cur.tier.id : null,
      measuredOn: m.ok ? m.source : null,
      preserved: ALWAYS_PRESERVED,
    });
  },

  async savingSet({ body }) {
    if (!body.tier) return bad("pick a tier", { choices: TIERS.map((t) => t.id) });
    const r = await setSaving(body.tier);
    return r.ok ? ok({ tier: r.tier.id, label: r.tier.label }) : bad(r.reason);
  },

  // --- providers and free capacity ----------------------------------------

  async providers() {
    const all = await providers.listAll();
    return ok({
      models: all.models,
      signIn: all.signIn,
      search: all.search,
      keyless: providers.catalogue().keyless ?? [],
      gatewayReachable: all.gatewayReachable,
      note: "What each provider gives is its own advertised allowance, not a measurement. The signup page is the authority.",
    });
  },

  async providerSetup({ query }) {
    const s = providers.setupSteps(query.id);
    return s.ok ? ok(s) : bad(s.reason);
  },

  async providerAdd({ body }) {
    if (!body.id) return bad("which provider?");
    if (providers.catalogue().search.some((s) => s.id === body.id)) {
      const r = providers.addSearchKey(body.id, body.key);
      if (!r.ok) return bad(r.reason);
      // 🔴 "Stored" is not "works", and the difference is the whole complaint.
      // A key written to disk that the search stack never actually calls looks
      // identical, from the app, to no key at all - the reader adds one, the
      // agent still says the provider is unavailable, and nothing anywhere says
      // why. So: run a REAL search through this provider before reporting
      // success, and say plainly if it did not answer.
      let works = null;
      let problem = null;
      try {
        const { webSearch } = await import("../tools/search.mjs");
        const t = await webSearch("omni agent connectivity check", { provider: body.id, count: 1 });
        works = t.results.length > 0;
        if (!works) problem = "the provider accepted the key but returned no results";
      } catch (err) {
        works = false;
        problem = String(err?.message ?? err);
      }
      // The key is kept either way: a provider that is down right now is not a
      // wrong key, and throwing it away would make the reader type it again.
      const active = availableProviders(loadConfig());
      return ok({
        added: body.id,
        kind: "search",
        works,
        problem,
        usedFor: active[0] === body.id ? "the next web search" : `after ${active.slice(0, active.indexOf(body.id)).join(", ")}`,
        order: active,
      });
    }
    // Counted before and after, because "key added" is not the answer to the
    // question the reader is actually asking, which is "so what can I use now?"
    const before = await modelIds();
    const r = await providers.addModelProvider(body.id, body.key);
    if (!r.ok) return bad(r.reason);
    const t = r.connectionId ? await providers.testConnection(r.connectionId) : null;
    // Invalidate the routing catalogue and re-resolve the agent's model BEFORE counting,
    // so `newModels` reports what is actually reachable now rather than what the stale
    // cache still remembers.
    const rewire = await providersChanged();
    const after = await modelIds();
    const fresh = [...after].filter((id) => !before.has(id));
    return ok({
      added: r.id,
      connectionId: r.connectionId,
      works: t ? t.ok : null,
      problem: (t && !t.ok ? t.error : null) ?? rewire.problem ?? null,
      remedy: t?.remedy ?? null,
      newModels: fresh.length,
      examples: fresh.slice(0, 5),
      agentModel: rewire.model,
      rewired: rewire.rewired,
    });
  },

  async providerSignin({ query }) {
    const r = await providers.signInUrl(query.id);
    if (!r.ok) return bad(r.reason);
    // Opening it is the user's decision; we hand over the URL and open a real
    // browser tab, and never drive the consent screen ourselves.
    openInBrowser(r.url);
    return ok({ url: r.url, opened: true, instruction: "Approve the sign-in in the browser window that just opened." });
  },

  async providerRemove({ body }) {
    if (!body.connectionId) return bad("which connection?");
    const r = await providers.removeConnection(body.connectionId);
    if (!r.ok) return bad(r.reason);
    const rewire = await providersChanged();
    return ok({ removed: body.connectionId, agentModel: rewire.model, rewired: rewire.rewired });
  },

  // --- search tools --------------------------------------------------------

  async search() {
    const cfg = loadConfig();
    const cat = providers.catalogue();
    const active = availableProviders(cfg);
    const secrets = new Set(listSecretNames());
    const describe = (id) => {
      const s = cat.search.find((x) => x.id === id);
      const k = (cat.keyless ?? []).find((x) => x.id === id);
      return {
        id,
        label: s?.label ?? k?.label ?? id,
        needsKey: !!s,
        hasKey: s ? secrets.has(s.secret) : true,
        note: s?.note ?? k?.note ?? null,
        signup: s?.signup ?? null,
        gives: s?.gives ?? "Works with no key at all",
        active: active.includes(id),
      };
    };
    return ok({
      order: cfg.search.order,
      providers: cfg.search.order.map(describe),
      scrape: cfg.scrape.order,
      note: "Search works with no key. A key removes the throttling the keyless endpoints hit. A stored key is used first automatically - nothing needs configuring.",
    });
  },

  // --- settings ------------------------------------------------------------

  async settingsGet() {
    return ok({ config: loadConfig(), defaults: DEFAULTS, secretsStored: listSecretNames() });
  },

  async settingsSet({ body }) {
    if (!body || typeof body !== "object") return bad("nothing to change");
    // Secrets never come through here; they have their own store and route.
    delete body.secrets;
    const cfg = updateConfig(body);
    return ok({ config: cfg });
  },

  // --- the user's own choices ---------------------------------------------
  //
  // Kept on disk rather than in the page's localStorage. The UI server takes a
  // fresh port on every launch, so the page is a NEW ORIGIN each time and
  // browser storage starts empty - which silently lost the Chat/Code tagging
  // of every conversation and the chosen model on every restart.

  async prefsGet() {
    return ok({ prefs: readPrefs() });
  },
  async prefsSet({ body }) {
    if (!body || typeof body !== "object") return bad("nothing to save");
    const prefs = { ...readPrefs(), ...body };
    // `kinds` is a growing map of sessionID -> "chat"|"code"; merge rather than
    // replace so one tab cannot drop what another recorded.
    if (body.kinds) prefs.kinds = { ...(readPrefs().kinds ?? {}), ...body.kinds };
    writePrefs(prefs);
    return ok({ prefs });
  },

  // --- the working folder --------------------------------------------------
  //
  // A session's working directory is fixed when the session is created:
  // `POST /session?directory=<absolute path>`. Measured 2026-08-28 - the
  // session then remembers it, so messages do NOT have to repeat the query,
  // and `GET /session` with no filter still lists sessions from every folder
  // (adding ?directory= to that call filters the sidebar down to one folder,
  // which is not what we want).
  //
  // So the folder is chosen BEFORE a conversation starts and cannot be moved
  // afterwards. The UI says so rather than offering a control that silently
  // does nothing.

  async folders() {
    const prefs = readPrefs();
    const chosen = typeof prefs.folder === "string" ? prefs.folder : null;
    const recent = Array.isArray(prefs.recentFolders) ? prefs.recentFolders : [];
    return ok({
      folder: chosen && fs.existsSync(chosen) ? chosen : PATHS.workspace,
      workspace: PATHS.workspace,
      // A folder that has since been deleted or unplugged is dropped rather
      // than offered as a choice that will fail.
      recent: recent.filter((p) => fs.existsSync(p)),
    });
  },

  /**
   * Set the folder new conversations will work in.
   *
   * Refuses anything that is not an existing directory: OpenCode accepts a
   * nonexistent `directory` without complaint and the failure only shows up
   * later, as an agent that cannot find any of the user's files.
   */
  async folderSet({ body }) {
    const p = typeof body?.path === "string" ? body.path.trim() : "";
    if (!p) return bad("no folder given");
    let full;
    try {
      full = path.resolve(p);
    } catch {
      return bad(`${p} is not a usable path`);
    }
    let stat = null;
    try {
      stat = fs.statSync(full);
    } catch {
      return bad(`${full} does not exist`);
    }
    if (!stat.isDirectory()) return bad(`${full} is a file, not a folder`);

    const prefs = readPrefs();
    const recent = [full, ...(Array.isArray(prefs.recentFolders) ? prefs.recentFolders : [])]
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 8);
    writePrefs({ ...prefs, folder: full, recentFolders: recent });
    return ok({ folder: full, recent });
  },

  /**
   * Open the real Windows "choose a folder" dialog.
   *
   * Typing a path is not a reasonable ask, and a browser cannot open a folder
   * picker that yields a usable path.
   */
  async folderPick() {
    const r = await showDialog(FOLDER_DIALOG);
    if (!r.ok) return r;
    if (r.cancelled) return ok({ cancelled: true });
    // `routes.folderSet`, not `this.folderSet`: the dispatcher pulls the
    // function out of the table before calling it, so `this` is undefined.
    return routes.folderSet({ body: { path: r.paths[0] } });
  },

  /** Open the real Windows "choose files" dialog, for attaching context. */
  async filePick() {
    const r = await showDialog(FILE_DIALOG);
    if (!r.ok) return r;
    if (r.cancelled) return ok({ cancelled: true, files: [] });
    return ok({ files: r.paths.map(describeFile).filter(Boolean) });
  },

  /** Describe files chosen some other way (typed, or dropped onto the window). */
  async fileDescribe({ body }) {
    const list = Array.isArray(body?.paths) ? body.paths : [];
    if (!list.length) return bad("no files given");
    const files = list.map((f) => describeFile(String(f))).filter(Boolean);
    if (!files.length) return bad("none of those are files that exist");
    return ok({ files });
  },

  // --- transcripts ---------------------------------------------------------

  async transcripts() {
    return transcripts.list();
  },
  async transcriptArchive({ body }) {
    // One session when asked for one - a forced re-export of everything is a
    // separate process per session and far too slow to sit behind a click.
    if (body?.id) return transcripts.archiveOne(body.id);
    return transcripts.archiveAll({ force: true });
  },
  async transcriptRestore({ body }) {
    if (!body.id) return bad("which transcript?");
    return transcripts.restore(body.id);
  },
  async transcriptForget({ body }) {
    if (!body.id) return bad("which transcript?");
    return transcripts.forget(body.id);
  },
  async transcriptAutoImport() {
    return transcripts.autoImport();
  },

  // --- routines ------------------------------------------------------------

  async routines() {
    return ok({ routines: routines.list() });
  },
  async routineCreate({ body }) {
    return routines.create(body);
  },
  async routineUpdate({ body }) {
    if (!body.id) return bad("which routine?");
    return routines.update(body.id, body.patch ?? {});
  },
  async routineDelete({ body }) {
    if (!body.id) return bad("which routine?");
    return routines.remove(body.id);
  },
  async routineRun({ body }) {
    if (!body.id) return bad("which routine?");
    return routines.run(body.id);
  },

  // --- tools, skills and plugins ------------------------------------------

  async tools() {
    const [skills, mcp, tools, commands] = await Promise.all([
      oc("GET", "/api/skill"),
      oc("GET", "/mcp"),
      // /experimental/tool requires a `provider` query and 400s without one;
      // /experimental/tool/ids is the whole list and needs nothing.
      oc("GET", "/experimental/tool/ids"),
      oc("GET", "/api/command"),
    ]);
    return ok({
      skills: skills.ok ? (skills.data?.data ?? skills.data ?? []) : [],
      mcp: mcp.ok ? (mcp.data ?? {}) : {},
      tools: tools.ok ? (tools.data?.data ?? tools.data ?? []) : [],
      commands: commands.ok ? (commands.data?.data ?? commands.data ?? []) : [],
    });
  },

  /**
   * Add an MCP connection.
   *
   * 🔴 The shape is not the obvious one and getting it wrong is a 400 that
   * blames the wrong field. OpenCode wants `{ name, config: { … } }` with
   * `additionalProperties: false` on BOTH levels - so the flat
   * `{ name, type, command, enabled }` this used to send failed validation on
   * the unexpected `type` and the missing `config.command` at once, and the
   * error surfaced as "command required", pointing at a field the user had
   * filled in. Read from the server's own /doc, 2026-08-28.
   *
   * A URL is a remote connection and a command is a local one; the caller only
   * has to say which it typed.
   */
  async mcpAdd({ body }) {
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) return bad("the connection needs a name");
    const url = typeof body?.url === "string" ? body.url.trim() : "";
    const command = Array.isArray(body?.command)
      ? body.command.map((c) => String(c).trim()).filter(Boolean)
      : String(body?.command ?? "").trim().split(/\s+/).filter(Boolean);
    if (!url && !command.length) return bad("give a command to run, or the URL of a remote server");
    const config = url
      ? { type: "remote", url, enabled: true }
      : { type: "local", command, enabled: true };
    const r = await oc("POST", "/mcp", { name, config });
    if (!r.ok) return bad(r.reason);
    // Persisted separately, because the route above connects the server for the
    // RUNNING agent and writes nothing: measured, an added connection reported
    // "connected", worked, and had vanished after a restart.
    updateConfig((cfg) => ({ ...cfg, mcp: { ...(cfg.mcp ?? {}), [name]: config } }));
    writeOpenCodeConfig();
    return ok({ added: name, config, data: r.data });
  },

  /** Forget an MCP connection. Without this a broken one could never be undone. */
  async mcpRemove({ body }) {
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) return bad("which connection?");
    let existed = false;
    updateConfig((cfg) => {
      const mcp = { ...(cfg.mcp ?? {}) };
      existed = Object.hasOwn(mcp, name);
      delete mcp[name];
      return { ...cfg, mcp };
    });
    writeOpenCodeConfig();
    // The running agent keeps it until it restarts; say so rather than implying
    // it is gone this second.
    await oc("POST", `/mcp/${encodeURIComponent(name)}/disconnect`, {});
    return ok({ removed: name, existed });
  },

  // --- the gateway dashboard ----------------------------------------------

  async dashboard({ query }) {
    const page = query.page ?? "home";
    const url = dashboardUrl(page);
    if (!url) return bad(`unknown page "${page}"`, { pages: Object.keys(PAGES) });
    if (query.open === "1") openInBrowser(url);
    return ok({
      url,
      page,
      pages: Object.entries(PAGES).map(([id, v]) => ({ id, label: v.label, url: dashboardUrl(id) })),
      password: dashboardPassword(),
      note: "The dashboard asks for a password. It is shown here because it is yours and you cannot sign in from any other browser without it.",
    });
  },
};
