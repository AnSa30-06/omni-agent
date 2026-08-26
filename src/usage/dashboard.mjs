// The usage / quota dashboard model.
//
// Assembles three genuinely different kinds of information and keeps them
// labelled apart, because conflating them is how a dashboard starts lying:
//
//   provider quota/balance  - what the provider itself reports (live or cached)
//   gateway free tier       - what OmniRoute reports, when a management key exists
//   local telemetry         - what this machine measured about this session
//
// A value is only ever rendered with the label it earned. There is no fallback
// that fills a blank with a guess.
import fs from "node:fs";
import { PATHS, ensureDirs } from "../util/paths.mjs";
import { logger } from "../util/log.mjs";
import { GatewayClient } from "../gateway/client.mjs";
import { queryProvider, configuredProviders, ADAPTERS } from "../providers/usage-adapters.mjs";
import { sessionSummary, todaySummary, rangeSummary } from "./telemetry.mjs";
import * as gatewayTel from "./gateway-telemetry.mjs";
import { loadConfig } from "../config.mjs";

const log = logger("dashboard");

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(PATHS.quotaCache, "utf8"));
  } catch {
    return {};
  }
}

function writeCache(cache) {
  ensureDirs();
  try {
    fs.writeFileSync(PATHS.quotaCache, JSON.stringify(cache, null, 2));
  } catch (err) {
    log.warn("quota cache write failed", { err: err.message });
  }
}

function ageOf(iso) {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function humaniseAge(ms) {
  if (ms == null) return "unknown";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + " second" + (s === 1 ? "" : "s") + " ago";
  const m = Math.round(s / 60);
  if (m < 60) return m + " minute" + (m === 1 ? "" : "s") + " ago";
  const h = Math.round(m / 60);
  if (h < 48) return h + " hour" + (h === 1 ? "" : "s") + " ago";
  return Math.round(h / 24) + " days ago";
}

/**
 * Live provider figures, falling back to the last known value with its age.
 * @param {{refresh?:boolean, providers?:string[]}} [opts]
 */
export async function providerStatus(opts = {}) {
  const cache = readCache();
  const ids = opts.providers ?? configuredProviders();
  const out = [];

  for (const id of ids) {
    let fresh = null;
    if (opts.refresh !== false) {
      try {
        fresh = await queryProvider(id);
      } catch (err) {
        log.warn("provider query threw", { id, err: err.message });
      }
    }

    // Only cache states that carry a real number.
    const hasLive = fresh && ["balance", "usage", "quota"].some((k) => fresh[k]?.state === "live");
    if (hasLive) {
      cache[id] = { at: new Date().toISOString(), data: fresh };
      out.push({ ...fresh, freshness: "live", fetchedAt: cache[id].at });
      continue;
    }

    const cached = cache[id];
    if (cached) {
      out.push({
        ...cached.data,
        freshness: "cached",
        fetchedAt: cached.at,
        ageMs: ageOf(cached.at),
        ageText: humaniseAge(ageOf(cached.at)),
        note: "Last known value. A live refresh did not succeed just now.",
        liveAttempt: fresh ?? null,
      });
      continue;
    }

    out.push({
      ...(fresh ?? { provider: id, label: ADAPTERS[id]?.label ?? id }),
      freshness: "unavailable",
      note: "No live value and nothing cached.",
    });
  }

  writeCache(cache);
  return out;
}

/** OmniRoute's own free-tier accounting. Management-scoped. */
export async function gatewayFreeTier(client = new GatewayClient()) {
  const r = await client.management("/api/free-tier/summary");
  if (r.ok) return { state: "live", data: r.data, fetchedAt: new Date().toISOString() };
  if (r.reason === "no-management-key") {
    return {
      state: "unavailable",
      reason: "Free-tier figures need a management-scoped gateway key",
      remedy: "Create a key with the 'manage' scope in the OmniRoute dashboard, then run: omni-agent config set-management-key",
    };
  }
  if (r.reason === "unauthorized") {
    return {
      state: "unavailable",
      reason: "The stored gateway key is not management-scoped",
      remedy: "Inference keys are rejected on /api/* with 403. Create a separate 'manage' key.",
    };
  }
  return { state: "error", reason: r.error ?? r.reason };
}

/** Everything the usage screen needs, in one call. */
export async function buildDashboard(opts = {}) {
  const cfg = loadConfig();
  const client = new GatewayClient();
  const up = await client.isUp();

  const [providers, freeTier] = await Promise.all([
    providerStatus(opts),
    up ? gatewayFreeTier(client) : Promise.resolve({ state: "unavailable", reason: "gateway not running" }),
  ]);

  let health = null;
  if (up) {
    try {
      health = await client.health();
    } catch {}
  }

  return {
    generatedAt: new Date().toISOString(),
    gateway: {
      baseUrl: client.baseUrl,
      running: up,
      version: health?.system?.version ?? null,
      uptimeSec: health?.system?.uptime ? Math.round(health.system.uptime) : null,
    },
    routing: {
      mode: cfg.routing.mode,
      pinnedModel: cfg.routing.pinnedModel,
    },
    providers,
    freeTier,
    telemetry: buildTelemetry(health?.system?.uptime),
  };
}

/**
 * Token usage.
 *
 * Prefers the GATEWAY's own call log, because the agent's model calls go
 * OpenCode -> plugin -> gateway and never pass through this process. Reading
 * only our own client's calls showed "0 tokens this session" while the agent
 * was actively working.
 *
 * Falls back to local telemetry when the gateway's log is unavailable.
 */
function buildTelemetry(gatewayUptimeSec) {
  if (gatewayTel.available()) {
    const g = { session: gatewayTel.sessionSummary(gatewayUptimeSec), today: gatewayTel.todaySummary(), last30Days: gatewayTel.rangeSummary(30) };
    if (g.last30Days.calls > 0) {
      return {
        // Local measurement of provider-reported counts. Not billing data.
        source: "gateway-call-log",
        note: "Every call routed through the gateway, including the agent's own.",
        ...g,
        directCalls: rangeSummary(30).calls,
      };
    }
  }
  return {
    source: "local-measurement",
    note: "Only calls made directly by this process; the gateway call log was unavailable.",
    session: sessionSummary(),
    today: todaySummary(),
    last30Days: rangeSummary(30),
  };
}

/** Render the dashboard as plain text for the CLI. */
export function renderDashboard(d) {
  const L = [];
  const bar = (frac) => {
    const n = Math.max(0, Math.min(16, Math.round(frac * 16)));
    return "#".repeat(n) + "-".repeat(16 - n);
  };

  L.push("MODEL GATEWAY");
  L.push(
    d.gateway.running
      ? `  Running at ${d.gateway.baseUrl} (OmniRoute ${d.gateway.version ?? "?"}, up ${d.gateway.uptimeSec ?? "?"}s)`
      : `  NOT RUNNING at ${d.gateway.baseUrl}`
  );
  L.push(`  Routing mode: ${d.routing.mode}${d.routing.pinnedModel ? `  (pinned: ${d.routing.pinnedModel})` : ""}`);
  L.push("");

  L.push("PROVIDER QUOTA / BALANCE");
  if (!d.providers.length) {
    L.push("  No provider API keys configured.");
    L.push("  The agent still works: the gateway serves free, no-credential models.");
  }
  for (const p of d.providers) {
    L.push(`  ${p.label ?? p.provider}`);
    const tag =
      p.freshness === "live"
        ? "Live"
        : p.freshness === "cached"
          ? `Last known value - updated ${p.ageText}`
          : "Unavailable";
    for (const field of ["balance", "usage", "quota"]) {
      const v = p[field];
      if (!v) continue;
      if (v.state === "live" || (p.freshness === "cached" && v.state === "live")) {
        if (v.kind === "money-balance") {
          L.push(`    Balance: ${v.total} ${v.currency}  (granted ${v.granted ?? "-"}, topped up ${v.toppedUp ?? "-"})`);
        } else if (v.kind === "credit-usage") {
          if (v.unlimited) {
            L.push(`    Credits used: ${v.used} ${v.currency}  (no spending limit set)`);
          } else {
            const frac = v.limit ? Math.max(0, v.remaining / v.limit) : 0;
            L.push(`    Credits: [${bar(frac)}] ${v.remaining} of ${v.limit} ${v.currency} remaining`);
          }
        } else if (v.kind === "token-usage") {
          L.push(`    Tokens (${v.window}): ${v.inputTokens} in / ${v.outputTokens} out`);
        } else if (v.kind === "money-spend") {
          L.push(`    Spend (${v.window}): ${v.spend} ${v.currency}`);
        }
        L.push(`    ${tag}`);
      } else if (v.state === "unavailable") {
        L.push(`    ${field}: unavailable from provider - ${v.reason}`);
        if (v.remedy) L.push(`      ${v.remedy}`);
      } else if (v.state === "error") {
        L.push(`    ${field}: could not be read - ${v.reason}`);
      }
    }
    L.push("");
  }

  L.push("GATEWAY FREE TIER");
  if (d.freeTier.state === "live") {
    const f = d.freeTier.data ?? {};
    const num = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : null);
    // Render only the fields the gateway actually sent. A missing field is
    // omitted, never defaulted - these are the gateway's numbers, not ours.
    const shown = [
      ["Steady monthly allowance", num(f.steadyRecurringTokens)],
      ["  including recurring credits", num(f.steadyWithRecurringCreditsTokens)],
      ["First month (with signup bonuses)", num(f.firstMonthRealisticTokens)],
      ["Boost allowance", num(f.boostMonthlyTokens)],
    ].filter(([, v]) => v != null);
    if (shown.length) {
      for (const [label, v] of shown) L.push(`  ${label}: ${v} tokens`);
      L.push("  Reported by the gateway. Depends on which upstream accounts you connect.");
    } else {
      L.push("  " + JSON.stringify(f).slice(0, 300));
    }
    L.push(`  Live - fetched ${humaniseAge(ageOf(d.freeTier.fetchedAt))}`);
  } else {
    L.push(`  Unavailable - ${d.freeTier.reason}`);
    if (d.freeTier.remedy) L.push(`  ${d.freeTier.remedy}`);
  }
  L.push("");

  const t = d.telemetry;
  L.push("TOKEN USAGE (measured on this machine)");
  L.push(`  Source: ${t.source}${t.note ? " - " + t.note : ""}`);
  L.push(`  Since gateway start: ${t.session.inputTokens} in / ${t.session.outputTokens} out / ${t.session.totalTokens} total  (${t.session.calls} calls)`);
  L.push(`  Today:        ${t.today.inputTokens} in / ${t.today.outputTokens} out / ${t.today.totalTokens} total  (${t.today.calls} calls)`);
  L.push(`  Last 30 days: ${t.last30Days.totalTokens} total  (${t.last30Days.calls} calls, ${t.last30Days.errors} errors)`);
  L.push(
    t.session.allProviderReported
      ? "  Token counts are provider-reported."
      : "  Some calls returned no usage block; totals below count only calls that did report usage."
  );
  const models = Object.entries(t.last30Days.byModel).sort((a, b) => b[1].totalTokens - a[1].totalTokens).slice(0, 8);
  if (models.length) {
    L.push("");
    L.push("  Per model (30d):");
    for (const [id, m] of models) {
      const tp = m.outputTokensPerSec != null ? `${m.outputTokensPerSec} tok/s measured over ${m.samples} calls` : "throughput not measured yet";
      L.push(`    ${id.padEnd(28)} ${String(m.totalTokens).padStart(9)} tok  ${m.calls} calls  ${tp}`);
    }
  }
  return L.join("\n");
}
