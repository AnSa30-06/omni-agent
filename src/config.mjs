// User settings. Deliberately contains no secrets - those live in the DPAPI
// store (src/util/secrets.mjs). This file is safe to read, print and export
// with diagnostics.
import fs from "node:fs";
import { PATHS, ensureDirs } from "./util/paths.mjs";

export const DEFAULTS = {
  version: 1,
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
  return deepMerge(DEFAULTS, onDisk);
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
