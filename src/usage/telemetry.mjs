// Local usage telemetry.
//
// Two jobs:
//  1. Show the user what this session actually cost in tokens.
//  2. Supply the ONLY honest throughput numbers in the product. Providers do
//     not publish tokens/sec, so rather than invent a figure we measure it:
//     output_tokens / latency on every real call. A model with no observed
//     calls has throughput `null`, and the UI prints "not measured yet" rather
//     than a number.
//
// Everything stays on the machine. Nothing is transmitted anywhere.
import fs from "node:fs";
import path from "node:path";
import { PATHS, ensureDirs } from "../util/paths.mjs";
import { logger } from "../util/log.mjs";
import { loadConfig } from "../config.mjs";

const log = logger("telemetry");

const SESSION_ID = new Date().toISOString().replace(/[:.]/g, "-") + "-" + process.pid;

function file(day = new Date()) {
  return path.join(PATHS.telemetry, day.toISOString().slice(0, 10) + ".jsonl");
}

/**
 * Record one model call.
 * `usage.source` is carried through untouched so consumers can distinguish
 * provider-reported token counts from anything we inferred.
 */
export function recordCall(entry) {
  const cfg = loadConfig();
  if (!cfg.telemetry.enabled) return null;
  ensureDirs();
  const row = {
    ts: new Date().toISOString(),
    session: SESSION_ID,
    requested: entry.requested ?? null,
    servedBy: entry.servedBy ?? null,
    provider: entry.provider ?? null,
    routingMode: entry.routingMode ?? null,
    task: entry.task ?? null,
    inputTokens: entry.usage?.inputTokens ?? null,
    outputTokens: entry.usage?.outputTokens ?? null,
    totalTokens: entry.usage?.totalTokens ?? null,
    cachedInputTokens: entry.usage?.cachedInputTokens ?? null,
    reasoningTokens: entry.usage?.reasoningTokens ?? null,
    usageSource: entry.usage?.source ?? "unavailable",
    latencyMs: entry.latencyMs ?? null,
    toolCalls: entry.toolCalls ?? 0,
    error: entry.error ?? null,
  };
  try {
    fs.appendFileSync(file(), JSON.stringify(row) + "\n");
  } catch (err) {
    log.warn("telemetry write failed", { err: err.message });
  }
  return row;
}

function readDay(day) {
  try {
    return fs
      .readFileSync(file(day), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** All rows from the last `days` days (inclusive of today). */
export function readRecent(days = 30) {
  const rows = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400000);
    rows.push(...readDay(d));
  }
  return rows;
}

function summarise(rows) {
  const s = {
    calls: rows.length,
    errors: rows.filter((r) => r.error).length,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    toolCalls: 0,
    /** True only if every counted row came from provider-reported usage. */
    allProviderReported: true,
    byModel: {},
  };
  for (const r of rows) {
    if (r.usageSource !== "provider") s.allProviderReported = false;
    s.inputTokens += r.inputTokens ?? 0;
    s.outputTokens += r.outputTokens ?? 0;
    s.totalTokens += r.totalTokens ?? 0;
    s.toolCalls += r.toolCalls ?? 0;
    const key = r.servedBy || r.requested || "unknown";
    const m = (s.byModel[key] ??= { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, latencies: [] });
    m.calls++;
    m.inputTokens += r.inputTokens ?? 0;
    m.outputTokens += r.outputTokens ?? 0;
    m.totalTokens += r.totalTokens ?? 0;
    if (r.latencyMs && r.outputTokens) m.latencies.push({ ms: r.latencyMs, out: r.outputTokens });
  }
  for (const m of Object.values(s.byModel)) {
    if (m.latencies.length) {
      const totMs = m.latencies.reduce((a, b) => a + b.ms, 0);
      const totOut = m.latencies.reduce((a, b) => a + b.out, 0);
      m.outputTokensPerSec = Number(((totOut / totMs) * 1000).toFixed(2));
      m.meanLatencyMs = Math.round(totMs / m.latencies.length);
      m.samples = m.latencies.length;
    } else {
      m.outputTokensPerSec = null;
      m.meanLatencyMs = null;
      m.samples = 0;
    }
    delete m.latencies;
  }
  return s;
}

export function sessionSummary() {
  return summarise(readDay().filter((r) => r.session === SESSION_ID));
}

export function todaySummary() {
  return summarise(readDay());
}

export function rangeSummary(days = 30) {
  return summarise(readRecent(days));
}

/**
 * Measured throughput per model id, from local observations only.
 * @returns {Record<string,{outputTokensPerSec:number|null, meanLatencyMs:number|null, samples:number}>}
 */
export function observedThroughput(days = 30) {
  const s = rangeSummary(days);
  const out = {};
  for (const [model, m] of Object.entries(s.byModel)) {
    out[model] = {
      outputTokensPerSec: m.outputTokensPerSec,
      meanLatencyMs: m.meanLatencyMs,
      samples: m.samples,
      /** Always local. Never presented as a provider-published figure. */
      source: "observed-local",
    };
  }
  return out;
}

export const sessionId = SESSION_ID;
