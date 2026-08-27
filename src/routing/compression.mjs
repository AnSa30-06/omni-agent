// Token saving, as a ladder a person can choose from.
//
// The gateway ships a 12-engine compression pipeline behind seven mode names
// (off · lite · standard · aggressive · ultra · rtk · stacked) that mean nothing
// to someone who just wants their free quota to last longer. This maps them to
// a ladder ordered by how much they save, says plainly what each one costs, and
// - importantly - measures the saving on the user's OWN recent requests rather
// than repeating a brochure figure.
import fs from "node:fs";
import path from "node:path";
import { admin } from "../gateway/admin.mjs";
import { PATHS } from "../util/paths.mjs";
import { logger } from "../util/log.mjs";

const log = logger("compression");

/**
 * The ladder, most saving first.
 *
 * `published` is OmniRoute's own figure for that mode. It is NOT a measurement
 * of this machine and is always labelled as the project's claim; `measure()`
 * below produces the real number.
 */
export const TIERS = [
  {
    id: "max",
    mode: "stacked",
    engines: {
      "session-dedup": { enabled: true },
      lite: { enabled: true },
      rtk: { enabled: true, level: "aggressive" },
      "codex-responses": { enabled: true },
      headroom: { enabled: true },
      relevance: { enabled: true },
      caveman: { enabled: true, level: "full" },
      aggressive: { enabled: true },
      ultra: { enabled: true },
    },
    rtk: { enabled: true, intensity: "aggressive", applyToToolResults: true, applyToAssistantMessages: true, enableGrouping: true, groupingThreshold: 3, maxLinesPerResult: 40 },
    label: "Maximum",
    published: "78-95%",
    axis: "tool output + conversation",
    summary: "Everything at once. Squeezes tool output and the conversation together.",
    costs: "Replies and history get noticeably terse. Best when quota is the binding constraint.",
  },
  {
    id: "high",
    mode: "ultra",
    engines: {
      "session-dedup": { enabled: true },
      lite: { enabled: true },
      relevance: { enabled: true },
      caveman: { enabled: true, level: "standard" },
      aggressive: { enabled: true },
      ultra: { enabled: true },
    },
    label: "High",
    published: "~75%",
    axis: "conversation",
    summary: "Heavy pruning of the conversation. Does little to tool output.",
    costs: "Wording is reshaped a lot. Meaning is kept; phrasing is not.",
  },
  {
    id: "tools",
    mode: "rtk",
    engines: {
      "session-dedup": { enabled: true },
      lite: { enabled: true },
      rtk: { enabled: true, level: "standard" },
      "codex-responses": { enabled: true },
      headroom: { enabled: true },
    },
    rtk: { enabled: true, intensity: "standard", applyToToolResults: true, applyToAssistantMessages: true, enableGrouping: true, groupingThreshold: 3, maxLinesPerResult: 60 },
    label: "Tool output only",
    published: "60-90% of tool output",
    axis: "tool output",
    summary: "Trims command, test, search and file output. Leaves the conversation alone.",
    costs: "Nothing in the conversation changes. The biggest safe win for coding work.",
  },
  {
    id: "balanced",
    mode: "aggressive",
    engines: {
      "session-dedup": { enabled: true },
      lite: { enabled: true },
      caveman: { enabled: true, level: "standard" },
      aggressive: { enabled: true },
    },
    label: "Balanced",
    published: "~50%",
    axis: "conversation",
    summary: "Summarises older turns and prunes as the conversation grows.",
    costs: "Detail from early in a long session gets condensed.",
  },
  {
    id: "light",
    mode: "standard",
    engines: {
      lite: { enabled: true },
      caveman: { enabled: true, level: "lite" },
    },
    label: "Light",
    published: "~30%",
    axis: "conversation",
    summary: "Removes filler, hedging and repetition from the conversation.",
    costs: "Almost nothing. Answers read more curtly.",
  },
  {
    id: "safe",
    mode: "lite",
    engines: { lite: { enabled: true } },
    label: "Safest",
    published: "~15%",
    axis: "everything, lightly",
    summary: "Whitespace and image-URL trimming only.",
    costs: "Nothing. This is the always-on baseline.",
  },
  {
    id: "off",
    mode: "off",
    engines: {},
    label: "Off",
    published: "0%",
    axis: "nothing",
    summary: "Send everything exactly as written.",
    costs: "Uses the most tokens of any setting.",
  },
];

/** Code, URLs and structured data are protected by the gateway in every mode. */
export const ALWAYS_PRESERVED = "Code blocks, URLs and structured data are never compressed, at any tier.";

const byId = new Map(TIERS.map((t) => [t.id, t]));
const byMode = new Map(TIERS.map((t) => [t.mode, t]));

export function tier(id) {
  return byId.get(id) ?? null;
}

/** Read the gateway's current compression settings and name the tier. */
export async function getSaving() {
  const r = await admin("GET", "/api/settings/compression");
  if (!r.ok) return { ok: false, reason: r.reason, remedy: r.remedy };
  const s = r.data ?? {};
  const mode = s.enabled === false ? "off" : (s.defaultMode ?? "off");
  return {
    ok: true,
    tier: byMode.get(mode) ?? byMode.get("off"),
    enabled: s.enabled !== false,
    defaultMode: s.defaultMode ?? "off",
    autoTriggerMode: s.autoTriggerMode ?? "off",
    autoTriggerTokens: s.autoTriggerTokens ?? 0,
    raw: s,
  };
}

/**
 * Every engine the gateway knows, with the ones this tier does not use turned
 * explicitly off. A partial map would leave a previous tier's engines running,
 * so moving DOWN the ladder would not reduce anything.
 */
const ALL_ENGINE_IDS = [
  "session-dedup",
  "ccr",
  "lite",
  "rtk",
  "codex-responses",
  "headroom",
  "relevance",
  "caveman",
  "aggressive",
  "llmlingua",
  "ultra",
  "omniglyph",
];

function allEngines(on = {}) {
  const out = {};
  for (const id of ALL_ENGINE_IDS) out[id] = on[id] ?? { enabled: false };
  return out;
}

/**
 * Set the saving tier.
 *
 * `off` is expressed as enabled:false rather than defaultMode:"off" so that
 * turning saving back on restores the previous pipeline instead of a blank one.
 */
export async function setSaving(id) {
  const t = byId.get(id);
  if (!t) return { ok: false, reason: `unknown tier "${id}"` };
  // The mode name alone does nothing.
  //
  // Measured: PUT {enabled:true, defaultMode:"stacked"} is accepted and changes
  // defaultMode, and the `engines` map is left exactly as it was - all twelve
  // off except caveman at lite. Previewing "stacked" in that state saved 0.2%.
  // The engines are what compress; the mode is a label next to them. So a tier
  // has to set both, or it is a setting that lies about what it does.
  const body =
    t.mode === "off"
      ? { enabled: false, defaultMode: "off" }
      : { enabled: true, defaultMode: t.mode, engines: allEngines(t.engines) };
  const r = await admin("PUT", "/api/settings/compression", body);
  if (!r.ok) return { ok: false, reason: r.reason, remedy: r.remedy };

  // RTK keeps its own config, and the engine flag does not reach it.
  //
  // Measured: engines.rtk.enabled=true with the default RTK config (enabled
  // false, intensity "minimal", no filters) saves 0% on pure tool output. With
  // the config below it saves 95.1% on the same payload - 757 tokens to 37.
  // Tool output is most of what an agent spends, so this is the single biggest
  // lever in the product and it is off by default.
  const rtkCfg = t.rtk ?? { enabled: false };
  const rtkRes = await admin("PUT", "/api/context/rtk/config", rtkCfg);
  if (!rtkRes.ok) log.warn("could not apply the RTK config", { reason: rtkRes.reason });
  log.info("set saving tier", { tier: t.id, mode: t.mode });
  return { ok: true, tier: t };
}

/**
 * Pull real request payloads out of the gateway's call log.
 *
 * Compression only matters on big payloads, so the biggest recent ones are the
 * honest sample. These never leave the machine: the preview runs against the
 * same loopback gateway that already handled them.
 *
 * @returns {{messages:any[], chars:number}[]}
 */
export function recentPayloads({ limit = 3, minChars = 400 } = {}) {
  const root = path.join(PATHS.gatewayData, "call_logs");
  if (!fs.existsSync(root)) return [];
  const found = [];
  const days = fs.readdirSync(root).sort().reverse().slice(0, 3);
  for (const day of days) {
    const dir = path.join(root, day);
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        const messages = j?.requestBody?.messages;
        if (!Array.isArray(messages) || !messages.length) continue;
        const chars = JSON.stringify(messages).length;
        if (chars < minChars) continue;
        // Whether this payload can exercise the tool-output engines at all.
        const hasToolOutput = messages.some((m) => m?.role === "tool" || Array.isArray(m?.tool_calls));
        found.push({ messages, chars, hasToolOutput });
      } catch {
        /* a half-written log is not an error worth surfacing */
      }
    }
    if (found.length > 60) break;
  }
  // Prefer payloads that actually contain tool output. Most of an agent's token
  // spend is tool output, and a sample without any cannot tell the user
  // anything about the tiers that target it - it would report 0% for the tier
  // that measured 93.9% on real agent traffic.
  return found
    .sort((a, b) => (b.hasToolOutput ? 1 : 0) - (a.hasToolOutput ? 1 : 0) || b.chars - a.chars)
    .slice(0, limit);
}


/**
 * A stand-in for real agent traffic: one user turn, one assistant turn, one
 * chunk of tool output. Used ONLY when the gateway has not handled anything
 * yet, and always labelled as not being the user's own traffic.
 *
 * Shaped like what this agent actually sends, because that is what the numbers
 * are meant to predict - tool output dominates an agent's token spend, and a
 * sample of pure prose would understate every tier that targets it.
 */
export const REPRESENTATIVE_SAMPLE = [
  { role: "user", content: "Run the test suite and tell me what is failing." },
  { role: "assistant", content: "Running the test suite now." },
  {
    role: "tool",
    content: [
      ...Array.from({ length: 60 }, (_, i) => `PASS src/module${i}.test.js (2.${i}s)`),
      "Test Suites: 60 passed, 60 total",
      "Tests: 240 passed",
      "Time: 12.4s",
    ].join("\n"),
  },
];

/**
 * Measure what each tier would actually save, on real payloads.
 *
 * Returns `measured: false` for a tier the gateway could not preview, rather
 * than falling back to the published figure - a number that is not a
 * measurement must never be displayed as one.
 */
export async function measure({ tiers = TIERS, samples = null } = {}) {
  let source = "your-traffic";
  if (!samples) samples = recentPayloads();
  // Real traffic with no tool output in it cannot rank these tiers, so say so
  // and use the representative payload rather than reporting a misleading 0%.
  if (!samples.length || !samples.some((s) => s.hasToolOutput)) {
    source = samples.length ? "representative-no-tool-output" : "representative";
    samples = [{ messages: REPRESENTATIVE_SAMPLE, chars: JSON.stringify(REPRESENTATIVE_SAMPLE).length, hasToolOutput: true }];
  }
  const results = [];
  for (const t of tiers) {
    if (t.mode === "off") {
      results.push({ ...t, measured: true, savedPct: 0, originalTokens: 0, compressedTokens: 0, samples: 0 });
      continue;
    }
    let original = 0;
    let compressed = 0;
    let n = 0;
    for (const s of samples) {
      const r = await admin("POST", "/api/compression/preview", {
        mode: t.mode,
        messages: s.messages,
        // Without this the preview uses whatever engines happen to be saved, so
        // every tier would report the CURRENT setting's saving under a
        // different name.
        config: { engines: allEngines(t.engines) },
      });
      const d = r.ok ? r.data : null;
      if (!d || typeof d.originalTokens !== "number" || typeof d.compressedTokens !== "number") continue;
      original += d.originalTokens;
      compressed += d.compressedTokens;
      n++;
    }
    results.push(
      n === 0
        ? { ...t, measured: false, samples: 0 }
        : {
            ...t,
            measured: true,
            samples: n,
            originalTokens: original,
            compressedTokens: compressed,
            savedPct: original > 0 ? Math.round(((original - compressed) / original) * 1000) / 10 : 0,
          }
    );
  }
  return { ok: true, results, sampleCount: samples.length, source };
}

/** Render the ladder for a terminal. */
export function renderTiers({ current = null, measured = null } = {}) {
  const L = [];
  L.push("TOKEN SAVING");
  L.push("");
  // Ordered by what it MEASURED, not by the order they are declared in.
  //
  // The seven modes do not sit on one dial: some target tool output, some
  // target the conversation. Measured on an agent-shaped payload, "high" saves
  // 0.7% and "tools" saves 93.9% - so presenting them as a single intensity
  // ladder, highest to lowest, would be presenting a fiction. Sort by the real
  // number and name the axis each one works on.
  const rows = measured?.results?.length ? measured.results : TIERS.map((t) => ({ ...t, measured: false }));
  const ordered = measured?.ok
    ? [...rows].sort((a, b) => (b.savedPct ?? 0) - (a.savedPct ?? 0))
    : rows;
  for (const t of ordered) {
    const here = current && current.id === t.id ? " <- current" : "";
    const saving = t.measured ? `${t.savedPct}% saved` : `${t.published} (unverified)`;
    L.push(`  ${t.id.padEnd(9)} ${t.label.padEnd(18)} ${saving.padEnd(16)} ${(t.axis ?? "").padEnd(24)}${here}`);
    L.push(`  ${" ".repeat(9)} ${t.summary}`);
    L.push(`  ${" ".repeat(9)} ${t.costs}`);
    L.push("");
  }
  if (measured?.ok && measured.source === "your-traffic") {
    L.push(`  "measured" = run on your own ${measured.sampleCount} largest recent request(s), locally.`);
  } else if (measured?.ok) {
    L.push('  These are measured on a representative agent payload, NOT your own traffic.');
    L.push(
      measured.source === "representative-no-tool-output"
        ? "  Your own recent requests carry no tool output, which is what most of these compress."
        : "  Use the agent for a while and run this again for your real numbers."
    );
  } else {
    L.push('  "published" = OmniRoute\'s own figure for that mode, not a measurement of your machine.');
    if (measured && measured.reason === "no-traffic-yet") {
      L.push("  Use the agent for a while, then run this again to see real numbers.");
    }
  }
  L.push(`  ${ALWAYS_PRESERVED}`);
  return L.join("\n");
}
