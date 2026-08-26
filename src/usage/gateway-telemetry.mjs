// Usage as recorded by the gateway itself.
//
// WHY THIS EXISTS: src/usage/telemetry.mjs only sees calls made through
// src/routing/execute.mjs - that is, calls this process makes. But the agent's
// own model calls go OpenCode -> OmniRoute plugin -> gateway, and never touch
// our client. Reporting only our own calls made the dashboard read "0 tokens
// this session" while the agent was actively working, which is worse than
// useless.
//
// The gateway writes one JSON file per call under <DATA_DIR>/call_logs/<date>/,
// containing the model actually served, the upstream provider, the duration and
// the token counts the upstream reported. That is the authoritative record for
// everything routed through it, so it is what the dashboard reads.
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../util/paths.mjs";
import { logger } from "../util/log.mjs";

const log = logger("gateway-telemetry");

function callLogRoot() {
  return path.join(PATHS.gatewayData, "call_logs");
}

/** Day directories, newest first, limited to the requested window. */
function dayDirs(days) {
  const root = callLogRoot();
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const cutoff = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  return entries
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name) && e.name >= cutoff)
    .map((e) => path.join(root, e.name))
    .sort()
    .reverse();
}

/**
 * Read call summaries.
 * Only the `summary` block is parsed - the files also contain the full request
 * and response bodies, which are large and would mean reading prompt text off
 * disk for no reason.
 *
 * @param {{days?:number, maxFiles?:number}} [opts]
 */
export function readGatewayCalls(opts = {}) {
  const days = opts.days ?? 30;
  const maxFiles = opts.maxFiles ?? 5000;
  const calls = [];
  for (const dir of dayDirs(days)) {
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const f of files) {
      if (calls.length >= maxFiles) return calls;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        if (j?.summary) calls.push(j.summary);
      } catch {
        // A file being written right now is expected; skip it silently.
      }
    }
  }
  return calls;
}

/** Summarise gateway-recorded calls into the same shape as local telemetry. */
export function summariseGateway(calls) {
  const s = {
    source: "gateway-call-log",
    calls: calls.length,
    errors: calls.filter((c) => c.status >= 400).length,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    allProviderReported: true,
    byModel: {},
  };
  for (const c of calls) {
    const t = c.tokens ?? {};
    const tin = t.in ?? 0;
    const tout = t.out ?? 0;
    if (t.in == null && t.out == null) s.allProviderReported = false;
    s.inputTokens += tin;
    s.outputTokens += tout;
    s.totalTokens += tin + tout;
    s.cachedInputTokens += t.cacheRead ?? 0;
    s.reasoningTokens += t.reasoning ?? 0;

    // The log carries both a bare served name ("big-pickle") and the qualified
    // id the caller asked for ("opencode/big-pickle"). The catalogue is keyed on
    // the qualified form, so record under BOTH - keying on the bare name alone
    // meant no measured throughput ever matched a catalogue entry.
    const keys = new Set([c.requestedModel, c.model].filter(Boolean));
    if (!keys.size) keys.add("unknown");
    for (const key of keys) {
      const m = (s.byModel[key] ??= {
        calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
        provider: c.provider ?? null, durations: [],
      });
      m.calls++;
      m.inputTokens += tin;
      m.outputTokens += tout;
      m.totalTokens += tin + tout;
      if (c.duration && tout) m.durations.push({ ms: c.duration, out: tout });
    }
  }
  for (const m of Object.values(s.byModel)) {
    if (m.durations.length) {
      const totMs = m.durations.reduce((a, b) => a + b.ms, 0);
      const totOut = m.durations.reduce((a, b) => a + b.out, 0);
      m.outputTokensPerSec = Number(((totOut / totMs) * 1000).toFixed(2));
      m.meanLatencyMs = Math.round(totMs / m.durations.length);
      m.samples = m.durations.length;
    } else {
      m.outputTokensPerSec = null;
      m.meanLatencyMs = null;
      m.samples = 0;
    }
    delete m.durations;
  }
  return s;
}

/**
 * Calls since the gateway started.
 *
 * "Since this CLI process started" would be the obvious reading and is useless:
 * for a one-shot `omni-agent usage` it is always zero. The gateway's uptime is
 * what a user actually means by "this session" - they launched the app, the
 * gateway came up, and they have been working since.
 *
 * @param {number} [uptimeSec] from /api/monitoring/health
 */
export function sessionSummary(uptimeSec) {
  if (!Number.isFinite(uptimeSec)) return summariseGateway([]);
  const since = new Date(Date.now() - uptimeSec * 1000).toISOString();
  return summariseGateway(readGatewayCalls({ days: 2 }).filter((c) => (c.timestamp ?? "") >= since));
}

export function todaySummary() {
  const today = new Date().toISOString().slice(0, 10);
  return summariseGateway(readGatewayCalls({ days: 1 }).filter((c) => (c.timestamp ?? "").startsWith(today)));
}

export function rangeSummary(days = 30) {
  return summariseGateway(readGatewayCalls({ days }));
}

/** Measured throughput per model, from the gateway's own duration records. */
export function observedThroughput(days = 30) {
  const s = rangeSummary(days);
  const out = {};
  for (const [model, m] of Object.entries(s.byModel)) {
    out[model] = {
      outputTokensPerSec: m.outputTokensPerSec,
      meanLatencyMs: m.meanLatencyMs,
      samples: m.samples,
      source: "observed-local",
    };
  }
  return out;
}

/** True when the gateway is actually writing call logs where we expect. */
export function available() {
  try {
    return fs.existsSync(callLogRoot());
  } catch {
    return false;
  }
}
