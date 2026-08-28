// User settings. Deliberately contains no secrets - those live in the DPAPI
// store (src/util/secrets.mjs). This file is safe to read, print and export
// with diagnostics.
import fs from "node:fs";
import { PATHS, ensureDirs } from "./util/paths.mjs";

export const DEFAULTS = {
  version: 2,
  /** Set true by the setup wizard once it completes successfully. */
  configured: false,
  gateway: {
    /** Port for the bundled, isolated OmniRoute instance. */
    port: 20129,
    /** When set, use an already-running gateway instead of spawning one. */
    externalBaseUrl: null,
    autoStart: true,
    startTimeoutMs: 180_000,
  },
  routing: {
    /** One of the presets in src/routing/presets.mjs. */
    mode: "balanced",
    /** When set, overrides routing entirely and pins one model id. */
    pinnedModel: null,
  },
  /**
   * MCP connections the user added, keyed by name.
   *
   * They live here rather than only in OpenCode because POST /mcp connects a
   * server for the RUNNING process and writes nothing - measured 2026-08-28: an
   * added connection reported "connected", worked, and was gone after a
   * restart. `writeOpenCodeConfig` emits these into opencode.json so they come
   * back.
   */
  mcp: {},
  search: {
    /** Ordered. First provider that has its credential (or needs none) wins. */
    order: ["brave", "tavily", "serper", "duckduckgo", "bravehtml", "searxng", "browser"],
  },
  scrape: {
    order: ["builtin", "browser", "firecrawl"],
    maxCrawlPages: 25,
  },
  browser: {
    headless: true,
    /** Chromium is downloaded into PATHS.browsers by the installer. */
    channel: null,
    timeoutMs: 45_000,
    /** Consequential submits always require explicit user authorisation. */
    allowFormSubmit: false,
  },
  permissions: {
    /** See config/permissions.json - this selects the profile. */
    profile: "standard",
  },
  telemetry: {
    /** Local-only. Nothing is ever sent off the machine. */
    enabled: true,
  },
  providers: {
    /** Provider ids the user enabled in setup, e.g. ["anthropic","deepseek"]. */
    enabled: [],
  },
};

function deepMerge(base, override) {
  if (override == null || typeof override !== "object" || Array.isArray(override)) return override ?? base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base && typeof base[k] === "object" && !Array.isArray(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function loadConfig() {
  ensureDirs();
  let onDisk = {};
  try {
    onDisk = JSON.parse(fs.readFileSync(PATHS.config, "utf8"));
  } catch {}
  const merged = deepMerge(DEFAULTS, onDisk);
  return migrate(merged, onDisk);
}

/**
 * Carry a saved config forward when the defaults gain something new.
 *
 * deepMerge cannot help here: an ARRAY on disk replaces the default array
 * wholesale, so a provider added to DEFAULTS in a new version is invisible to
 * everyone who already has a config file - which is every existing install.
 * Measured: `bravehtml` was added to the default search order and the effective
 * order on this machine stayed exactly as it was.
 *
 * So provider lists are reconciled ONCE, stamped with the version, and left
 * alone afterwards. That way a new keyless provider reaches existing users, and
 * a user who later removes one on purpose does not have it put back every run.
 */
function migrate(cfg, onDisk) {
  if (!onDisk || Object.keys(onDisk).length === 0) return cfg;
  if ((onDisk.version ?? 1) >= DEFAULTS.version) return cfg;

  for (const group of ["search", "scrape"]) {
    const defaults = DEFAULTS[group]?.order ?? [];
    const current = cfg[group]?.order ?? [];
    const missing = defaults.filter((id) => !current.includes(id));
    if (!missing.length) continue;
    // Rebuild in DEFAULTS order for the ids both know about, then append
    // anything the user added that defaults do not carry.
    const known = defaults.filter((id) => current.includes(id) || missing.includes(id));
    const extra = current.filter((id) => !defaults.includes(id));
    cfg[group].order = [...known, ...extra];
  }

  cfg.version = DEFAULTS.version;
  try {
    fs.writeFileSync(PATHS.config, JSON.stringify(cfg, null, 2));
  } catch {
    /* a read-only config is not worth crashing a launch over */
  }
  return cfg;
}

export function saveConfig(cfg) {
  ensureDirs();
  fs.writeFileSync(PATHS.config, JSON.stringify(cfg, null, 2));
  return cfg;
}

export function updateConfig(mutator) {
  const cfg = loadConfig();
  const next = typeof mutator === "function" ? mutator(cfg) ?? cfg : deepMerge(cfg, mutator);
  return saveConfig(next);
}

/** The base URL every client in this repo should talk to. */
export function gatewayBaseUrl(cfg = loadConfig()) {
  if (process.env.OMNI_AGENT_GATEWAY_URL) return process.env.OMNI_AGENT_GATEWAY_URL.replace(/\/$/, "");
  if (cfg.gateway.externalBaseUrl) return cfg.gateway.externalBaseUrl.replace(/\/$/, "");
  return `http://127.0.0.1:${cfg.gateway.port}`;
}
