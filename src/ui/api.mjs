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
    const groups = (Array.isArray(all) ? all : []).map((p) => ({
      id: p.id,
      name: p.name ?? p.id,
      // The gateway is this product's own provider; it goes first.
      preferred: p.id === "opencode-omniroute",
      default: defaults[p.id] ?? null,
      models: Object.entries(p.models ?? {})
        .map(([id, m]) => ({
          id,
          name: m.name ?? id,
          context: m.limit?.context ?? null,
          output: m.limit?.output ?? null,
          free: (m.cost?.input ?? 0) === 0 && (m.cost?.output ?? 0) === 0,
          reasoning: !!m.reasoning,
          attachments: !!m.attachment,
          // Some providers list image and audio generators beside their chat
          // models. They are real models and they cannot hold a conversation,
          // so they must never be offered as a default: the gateway's own
          // published default here is `pollinations/zimage`, an image model,
          // which is what the picker landed on before this filter existed.
          textOut: m.modalities?.output?.text !== false,
        }))
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
      return r.ok ? ok({ added: body.id, kind: "search" }) : bad(r.reason);
    }
    const r = await providers.addModelProvider(body.id, body.key);
    if (!r.ok) return bad(r.reason);
    const t = r.connectionId ? await providers.testConnection(r.connectionId) : null;
    return ok({ added: r.id, connectionId: r.connectionId, works: t ? t.ok : null, problem: t && !t.ok ? t.error : null, remedy: t?.remedy ?? null });
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
    return r.ok ? ok({ removed: body.connectionId }) : bad(r.reason);
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
   * picker that yields a usable path. FolderBrowserDialog needs a
   * single-threaded apartment, hence -STA, and an owner window that is
   * TopMost - without one the dialog opens BEHIND the app and looks like a
   * freeze.
   */
  async folderPick() {
    if (process.platform !== "win32") return bad("the folder picker is Windows-only; type a path instead");
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$owner = New-Object System.Windows.Forms.Form",
      "$owner.TopMost = $true",
      "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$d.Description = 'Choose the folder Omni Agent should work in'",
      "$d.ShowNewFolderButton = $true",
      "if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }",
      "$owner.Dispose()",
    ].join("; ");
    // Asynchronously, and that is not a style choice: the dialog stays open
    // for as long as the user browses, and execFileSync would block this
    // server's event loop for all of it - the app would freeze mid-click.
    const { spawn } = await import("node:child_process");
    const picked = await new Promise((resolve) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-STA", "-Command", script], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      let out = "";
      child.stdout.on("data", (b) => (out += b.toString()));
      child.on("error", () => resolve(null));
      child.on("close", () => resolve(out.trim()));
    });
    if (picked === null) return bad("the folder picker could not open");
    if (!picked) return ok({ cancelled: true });
    // `routes.folderSet`, not `this.folderSet`: the dispatcher pulls the
    // function out of the table before calling it, so `this` is undefined.
    return routes.folderSet({ body: { path: picked } });
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

  async mcpAdd({ body }) {
    if (!body.name) return bad("the connection needs a name");
    const r = await oc("POST", "/mcp", body);
    return r.ok ? ok({ added: body.name, data: r.data }) : bad(r.reason);
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
