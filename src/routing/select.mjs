// Model selection.
//
// Two layers, and the order matters:
//
//  1. Prefer an OmniRoute `auto/*` combo. The gateway knows which credentials
//     are live, which upstreams are rate-limited and which are free right now;
//     this client knows none of that. Delegating to a combo is strictly better
//     informed than picking a vendor model from here.
//  2. Score concrete models only when no combo fits, or when the user has asked
//     for a specific model.
//
// Nothing here invents a number. When cost is unknown the cost term is dropped
// from the weighting and the weights are renormalised, so "cheap" mode degrades
// to "fast and small" rather than silently ranking everything as free.
import { getCatalogue, capabilityScore, speedScore, costScore, metadata } from "./catalog.mjs";
import { logger } from "../util/log.mjs";
import { loadConfig } from "../config.mjs";

const log = logger("routing");

/** Routing presets. Weights are deliberately not one universal set. */
export const PRESETS = {
  fast: {
    label: "Fast",
    description: "Highest throughput and lowest latency that can still finish the job.",
    weights: { capability: 0.2, speed: 0.55, cost: 0.15, context: 0.1 },
    minCapability: "medium",
    comboOrder: ["auto/best-fast", "auto/fast", "auto/chat"],
  },
  balanced: {
    label: "Balanced",
    description: "Sensible default: good model, reasonable speed, reasonable cost.",
    weights: { capability: 0.45, speed: 0.25, cost: 0.2, context: 0.1 },
    minCapability: "strong",
    comboOrder: ["auto/smart", "auto/coding", "auto/chat"],
  },
  smart: {
    label: "Smart",
    description: "The strongest model that is still reasonably efficient.",
    weights: { capability: 0.65, speed: 0.15, cost: 0.1, context: 0.1 },
    minCapability: "strong",
    comboOrder: ["auto/pro-reasoning", "auto/smart", "auto/best-reasoning"],
  },
  quality: {
    label: "Maximum Quality",
    description: "The strongest suitable model. Speed and cost barely matter.",
    weights: { capability: 0.85, speed: 0.03, cost: 0.02, context: 0.1 },
    minCapability: "very-strong",
    comboOrder: ["auto/best-reasoning", "auto/best-coding", "auto/pro-reasoning"],
  },
  cheap: {
    label: "Cheap",
    description: "The cheapest model that can still complete the task.",
    weights: { capability: 0.25, speed: 0.2, cost: 0.45, context: 0.1 },
    minCapability: "medium",
    comboOrder: ["auto/cheap", "auto/best-free", "auto/fast"],
  },
};

// Intent x preset -> ordered combo preferences.
//
// Both dimensions have to bite. Keying only on intent made every preset resolve
// to the same combo for a given task, which silently disabled the mode selector;
// keying only on the preset would ignore what the task actually needs. The
// gateway publishes tiered variants (auto/coding:fast, :cheap, :pro) precisely
// so a client can express both at once.
const INTENT_COMBOS = {
  coding: {
    quality: ["auto/best-coding", "auto/coding:pro", "auto/pro-coding"],
    smart: ["auto/pro-coding", "auto/coding:pro", "auto/best-coding"],
    balanced: ["auto/coding", "auto/coding:reliable", "auto/pro-coding"],
    fast: ["auto/coding:fast", "auto/best-coding-fast", "auto/coding"],
    cheap: ["auto/coding:cheap", "auto/coding:free", "auto/cheap"],
  },
  "hard-reasoning": {
    quality: ["auto/best-reasoning", "auto/reasoning:pro"],
    smart: ["auto/reasoning:pro", "auto/pro-reasoning", "auto/best-reasoning"],
    balanced: ["auto/reasoning", "auto/pro-reasoning"],
    fast: ["auto/best-fast", "auto/reasoning"],
    cheap: ["auto/cheap", "auto/reasoning"],
  },
  reasoning: {
    quality: ["auto/best-reasoning", "auto/reasoning:pro"],
    smart: ["auto/pro-reasoning", "auto/reasoning"],
    balanced: ["auto/reasoning", "auto/smart"],
    fast: ["auto/best-fast", "auto/fast"],
    cheap: ["auto/cheap", "auto/best-free"],
  },
  cheap: {
    quality: ["auto/cheap", "auto/best-free"],
    smart: ["auto/cheap", "auto/best-free"],
    balanced: ["auto/cheap", "auto/best-free", "auto/fast"],
    fast: ["auto/fast", "auto/cheap"],
    cheap: ["auto/best-free", "auto/cheap"],
  },
  fast: {
    quality: ["auto/best-fast", "auto/fast"],
    smart: ["auto/best-fast", "auto/fast"],
    balanced: ["auto/best-fast", "auto/fast", "auto/chat"],
    fast: ["auto/fast", "auto/best-fast"],
    cheap: ["auto/cheap", "auto/fast"],
  },
  vision: {
    quality: ["auto/best-vision", "auto/pro-vision", "auto/vision"],
    smart: ["auto/pro-vision", "auto/best-vision", "auto/vision"],
    balanced: ["auto/vision", "auto/multimodal", "auto/pro-vision"],
    fast: ["auto/vision", "auto/multimodal"],
    cheap: ["auto/vision", "auto/multimodal"],
  },
  smart: {
    quality: ["auto/best-reasoning", "auto/smart"],
    smart: ["auto/smart", "auto/pro-reasoning"],
    balanced: ["auto/smart", "auto/chat"],
    fast: ["auto/best-fast", "auto/smart"],
    cheap: ["auto/cheap", "auto/smart"],
  },
  chat: {
    quality: ["auto/best-chat", "auto/pro-chat", "auto/chat"],
    smart: ["auto/pro-chat", "auto/chat"],
    balanced: ["auto/chat", "auto/pro-chat"],
    fast: ["auto/best-fast", "auto/fast", "auto/chat"],
    cheap: ["auto/cheap", "auto/chat"],
  },
};
INTENT_COMBOS.balanced = INTENT_COMBOS.smart;
INTENT_COMBOS.general = INTENT_COMBOS.smart;

const TIER_ORDER = ["fast-basic", "medium", "strong", "very-strong", "elite"];
function tierAtLeast(tier, min) {
  if (!tier || !min) return true;
  return TIER_ORDER.indexOf(tier) >= TIER_ORDER.indexOf(min);
}

function contextScore(model, needed) {
  if (!model.contextLength) return 0.5;
  if (!needed) return Math.min(1, model.contextLength / 200000);
  return model.contextLength >= needed ? 1 : 0;
}

/**
 * Choose a model.
 *
 * @param {{
 *   task?: string,            // e.g. "classify" | "code" | "plan"
 *   mode?: string,            // preset id; defaults to the configured one
 *   needsTools?: boolean,
 *   needsVision?: boolean,
 *   contextNeeded?: number,
 *   pinnedModel?: string,
 *   catalogue?: Array
 * }} req
 */
export async function selectModel(req = {}) {
  const cfg = loadConfig();
  const mode = req.mode ?? cfg.routing.mode ?? "balanced";
  const preset = PRESETS[mode] ?? PRESETS.balanced;
  const catalogue = req.catalogue ?? (await getCatalogue());
  const byId = new Map(catalogue.map((m) => [m.id, m]));

  // 1. An explicit pin always wins, but must actually exist.
  const pin = req.pinnedModel ?? cfg.routing.pinnedModel;
  if (pin) {
    if (!byId.has(pin)) {
      throw new Error(
        `pinned model "${pin}" is not in the gateway catalogue. Clear the pin or choose one of ${catalogue.length} available models.`
      );
    }
    return { model: pin, via: "user-pin", mode, reason: "explicitly pinned by the user", candidate: byId.get(pin) };
  }

  // 2. Task -> intent -> combo. Delegation beats guessing.
  const md = metadata();
  const intent = req.intent ?? (req.task ? md.tasks[req.task] : null);
  const intentTable = intent ? INTENT_COMBOS[intent] : null;
  const comboCandidates = [
    ...(intentTable?.[mode] ?? intentTable?.balanced ?? []),
    ...preset.comboOrder,
  ];
  for (const combo of comboCandidates) {
    const m = byId.get(combo);
    if (!m) continue;
    if (req.needsTools && !m.capabilities.toolCalling) continue;
    // Measured, not assumed: auto/best-vision has reported vision:false before.
    if (req.needsVision && !m.capabilities.vision) continue;
    if (req.contextNeeded && m.contextLength && m.contextLength < req.contextNeeded) continue;
    return {
      model: combo,
      via: "gateway-combo",
      mode,
      intent: intent ?? null,
      reason: `delegated to the gateway combo ${combo}, which routes and falls back with knowledge of live credentials and rate limits`,
      candidate: m,
    };
  }

  // 3. Score concrete models.
  const eligible = catalogue.filter((m) => {
    if (m.isCombo) return false;
    if (req.needsTools && !m.capabilities.toolCalling) return false;
    if (req.needsVision && !m.capabilities.vision) return false;
    if (req.contextNeeded && m.contextLength && m.contextLength < req.contextNeeded) return false;
    if (!tierAtLeast(m.capabilityTier, preset.minCapability)) return false;
    return true;
  });

  const pool = eligible.length ? eligible : catalogue.filter((m) => !m.isCombo && (!req.needsTools || m.capabilities.toolCalling));
  if (!pool.length) throw new Error("no model in the catalogue satisfies this request");

  const scored = pool
    .map((m) => {
      const w = { ...preset.weights };
      const cost = costScore(m);
      // Unknown cost: drop the term and renormalise, rather than scoring it 0
      // (which would punish every model equally and misrank) or 1 (which would
      // pretend it is free).
      if (cost == null) {
        const removed = w.cost;
        delete w.cost;
        const total = Object.values(w).reduce((a, b) => a + b, 0);
        for (const k of Object.keys(w)) w[k] += (w[k] / total) * removed;
      }
      const parts = {
        capability: capabilityScore(m.capabilityTier) * (w.capability ?? 0),
        speed: speedScore(m) * (w.speed ?? 0),
        cost: cost == null ? 0 : cost * (w.cost ?? 0),
        context: contextScore(m, req.contextNeeded) * (w.context ?? 0),
      };
      return { model: m, score: Object.values(parts).reduce((a, b) => a + b, 0), parts, costKnown: cost != null };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  log.info("selected model", { model: best.model.id, mode, score: best.score.toFixed(3) });
  return {
    model: best.model.id,
    via: "scored",
    mode,
    intent: intent ?? null,
    reason:
      `highest score under the "${preset.label}" preset` +
      (best.costKnown ? "" : " (cost unknown for this model, so the cost term was dropped and the remaining weights renormalised)"),
    score: Number(best.score.toFixed(4)),
    parts: best.parts,
    candidate: best.model,
    runnersUp: scored.slice(1, 4).map((s) => ({ model: s.model.id, score: Number(s.score.toFixed(4)) })),
  };
}

/** Ordered fallbacks to try when the chosen model fails on quota/rate-limit. */
export async function fallbackChain(req = {}) {
  const primary = await selectModel(req);
  const catalogue = req.catalogue ?? (await getCatalogue());
  const byId = new Map(catalogue.map((m) => [m.id, m]));
  const chain = [primary.model];
  for (const id of ["auto/smart", "auto/chat", "auto/fast", "auto/best-free"]) {
    if (!chain.includes(id) && byId.has(id)) chain.push(id);
  }
  return { primary, chain };
}
