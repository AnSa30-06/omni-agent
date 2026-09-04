// The model catalogue: live discovery, enriched with local metadata.
//
// The model list is ALWAYS read from the gateway's /v1/models. Nothing in this
// repo hard-codes a model id, so a new release upstream shows up without a code
// change and a retired one disappears instead of 404-ing at call time.
//
// Enrichment is layered and each layer declares where it came from, because the
// UI has to be able to say "measured here" vs "our estimate" vs "provider says".
import fs from "node:fs";
import { pkg } from "../util/paths.mjs";
import { logger } from "../util/log.mjs";
import { GatewayClient } from "../gateway/client.mjs";
import { observedThroughput } from "../usage/telemetry.mjs";
import * as gatewayTel from "../usage/gateway-telemetry.mjs";

const log = logger("catalog");

let _metadata = null;
export function metadata() {
  if (_metadata) return _metadata;
  _metadata = JSON.parse(fs.readFileSync(pkg("config", "models", "metadata.json"), "utf8"));
  return _metadata;
}

const CAPABILITY_SCORE = { "fast-basic": 0.2, medium: 0.45, strong: 0.65, "very-strong": 0.85, elite: 1.0 };
const SPEED_SCORE = { slow: 0.2, medium: 0.5, fast: 0.75, "very-fast": 1.0 };

/**
 * Tier for a gateway combo, derived from its own naming scheme.
 *
 * OmniRoute names combos systematically (`auto/best-*`, `auto/pro-*`,
 * `auto/<intent>:<flavour>`), so deriving from the name covers every combo the
 * gateway will ever add. An explicit entry in metadata.json still wins, but the
 * table no longer has to be exhaustive - which is what left 55 combos untiered.
 */
function comboTiers(id) {
  const slug = id.replace(/^auto\//, "");
  const flavour = slug.includes(":") ? slug.split(":")[1] : null;
  const intent = slug.split(":")[0].replace(/^(best|pro)-/, "");

  let capability = "strong";
  let speed = "fast";
  if (/^best-/.test(slug) || flavour === "pro") capability = "elite";
  else if (/^pro-/.test(slug) || flavour === "reliable") capability = "very-strong";
  if (flavour === "fast" || /(^|-)fast$/.test(intent)) speed = "very-fast";
  if (flavour === "cheap" || flavour === "free" || intent === "cheap" || intent === "free") {
    capability = "medium";
    speed = "very-fast";
  }
  if (/reasoning|coding/.test(intent) && capability === "elite") speed = "medium";
  return { capability_tier: capability, speed_tier: speed, intent, flavour };
}

/** Local editorial tiers for one model id. Never a benchmark. */
export function estimateTiers(id) {
  const md = metadata();
  if (md.combos[id]) {
    return { ...md.combos[id], source: "local-estimate", isCombo: true };
  }
  if (String(id).startsWith("auto/")) {
    return { ...comboTiers(id), source: "derived-from-combo-name", isCombo: true, recommended_tasks: [] };
  }
  for (const p of md.patterns) {
    if (new RegExp(p.match, "i").test(id)) {
      return {
        capability_tier: p.capability_tier,
        speed_tier: p.speed_tier,
        recommended_tasks: p.recommended_tasks ?? [],
        source: "local-estimate",
        isCombo: false,
        matchedPattern: p.match,
      };
    }
  }
  // Unknown model: say so rather than guess it into a tier.
  return { capability_tier: null, speed_tier: null, recommended_tasks: [], source: "unknown", isCombo: false };
}

let _cache = { at: 0, models: null };
const TTL_MS = 5 * 60 * 1000;

/**
 * Full catalogue.
 * @param {{force?:boolean, client?:GatewayClient}} [opts]
 */
export async function getCatalogue(opts = {}) {
  if (!opts.force && _cache.models && Date.now() - _cache.at < TTL_MS) return _cache.models;
  const client = opts.client ?? new GatewayClient();
  const raw = await client.listModels();
  // Gateway-recorded calls cover everything, including the agent's own model
  // calls, which never pass through this client. Local telemetry is merged in
  // underneath for anything the gateway did not serve.
  const throughput = { ...observedThroughput(), ...(gatewayTel.available() ? gatewayTel.observedThroughput() : {}) };

  // Pricing is management-scoped. Absent a key it is genuinely unknown, and the
  // catalogue says so rather than defaulting to zero (which would make every
  // cheap-mode decision silently wrong).
  let pricing = null;
  const p = await client.management("/api/pricing");
  if (p.ok) pricing = p.data;

  const models = raw.map((m) => {
    const tiers = estimateTiers(m.id);
    const obs = lookupThroughput(throughput, m.id);
    const price = findPrice(pricing, m.id);
    return {
      id: m.id,
      displayName: m.name ?? m.id,
      owner: m.owned_by ?? null,
      isCombo: m.owned_by === "combo" || String(m.id).startsWith("auto/"),
      contextLength: m.context_length ?? m.max_input_tokens ?? null,
      maxOutputTokens: m.max_output_tokens ?? null,
      capabilities: {
        toolCalling: !!m.capabilities?.tool_calling,
        vision: !!m.capabilities?.vision,
        reasoning: !!m.capabilities?.reasoning,
      },
      capabilityTier: tiers.capability_tier,
      speedTier: tiers.speed_tier,
      tierSource: tiers.source,
      recommendedTasks: tiers.recommended_tasks ?? [],
      /** null until this installation has actually measured this model. */
      observed: obs,
      pricing: price,
    };
  });

  _cache = { at: Date.now(), models };
  log.info("catalogue refreshed", { count: models.length, pricing: pricing ? "available" : "unavailable" });
  return models;
}

/**
 * Join measured throughput onto a catalogue entry.
 *
 * Falls back to the bare model name because the two sides use different
 * provider aliases for the SAME model: the catalogue publishes the short alias
 * (`oc/big-pickle`, `felo/felo-chat`) while the call log records the canonical
 * name (`opencode/big-pickle`, `felo-web/felo-chat`). Upstream documents this
 * alias/canonical duality explicitly.
 *
 * NOTE the deliberate asymmetry with findPrice(), which refuses exactly this
 * fallback. Joining a bare name for THROUGHPUT relates two aliases of one model
 * on one upstream. Joining a bare name for PRICE would relate two DIFFERENT
 * upstreams that happen to serve a similarly-named model - stamping OpenAI's
 * price on a free proxy. Same technique, one is correct and one is a lie.
 */
function lookupThroughput(throughput, id) {
  if (throughput[id]) return throughput[id];
  const bare = String(id).split("/").pop();
  return throughput[bare] ?? null;
}

/**
 * Look up per-million-token pricing for one model id.
 *
 * The gateway returns a nested { provider: { model: {input, output, ...} } }
 * map, priced in USD per million tokens.
 *
 * MEASURED, AND THE REASON THIS IS STRICTER THAN IT LOOKS: the pricing table and
 * the live catalogue occupy disjoint provider namespaces on a fresh install.
 * Pricing covers credentialed upstreams (openai, anthropic, gemini, deepseek,
 * cc, ...); the zero-credential catalogue is served by free proxies (ddgw, felo,
 * aug, pepper, ...). Overlap on `provider/model` is exactly zero.
 *
 * Matching on the bare model name instead would "find" 5 of 115 - and every one
 * of those would be wrong. `ddgw/gpt-5.4-mini` is a free proxy; stamping
 * OpenAI's $1.50/$6.00 on it would invent a cost the user is not paying and then
 * rank routing decisions on it. So: exact provider/model only, otherwise the
 * cost is genuinely unknown and says so.
 */
function findPrice(pricing, id) {
  if (!pricing) return { inputPerMTok: null, outputPerMTok: null, source: "unavailable", reason: "no management key" };
  const slash = String(id).indexOf("/");
  if (slash < 0) return { inputPerMTok: null, outputPerMTok: null, source: "unavailable", reason: "unqualified model id" };
  const provider = id.slice(0, slash);
  const model = id.slice(slash + 1);
  const hit = pricing?.[provider]?.[model];
  if (!hit) {
    return {
      inputPerMTok: null,
      outputPerMTok: null,
      source: "unavailable",
      reason: "no published price for this provider/model",
    };
  }
  return {
    inputPerMTok: hit.input ?? null,
    outputPerMTok: hit.output ?? null,
    cachedInputPerMTok: hit.cached ?? null,
    reasoningPerMTok: hit.reasoning ?? null,
    currency: "USD",
    unit: "per million tokens",
    source: "gateway-pricing-api",
  };
}

/**
 * The one line about a model that a non-specialist can actually act on.
 *
 * A tier name like "very-strong" is meaningless to someone who does not follow
 * model releases; "roughly Sonnet 5 level" is not, because that is the ladder
 * everyone has heard of. Anthropic's names are the yardstick only because they
 * are the best known - this is not a claim about Anthropic.
 *
 * ⚠️ It is an ESTIMATE OF POSITIONING, never a benchmark result, so the strings
 * live beside the disclaimer in metadata.json and all say "roughly".
 *
 * @returns {string|null} null when the tier is unknown, so the UI shows nothing
 *   rather than guessing.
 */
export function comparisonFor(tier, id = null) {
  if (!tier) return null;
  const md = metadata();
  // Never compare the yardstick to itself: "claude-opus-5 - roughly Opus 5
  // level" is noise, and it makes the whole label look automated rather than
  // useful.
  const self = md.comparisonSelf?.[tier];
  if (self && id && new RegExp(self, "i").test(String(id))) return null;
  return md.comparisons?.[tier] ?? null;
}

export function capabilityScore(tier) {
  return CAPABILITY_SCORE[tier] ?? 0.4;
}
export function speedScore(model) {
  // A measured rate beats an editorial tier whenever we have one.
  if (model.observed?.outputTokensPerSec != null && model.observed.samples >= 2) {
    // 120 tok/s treated as the top of the practical scale.
    return Math.max(0, Math.min(1, model.observed.outputTokensPerSec / 120));
  }
  return SPEED_SCORE[model.speedTier] ?? 0.5;
}
export function costScore(model) {
  const out = model.pricing?.outputPerMTok;
  const inp = model.pricing?.inputPerMTok;
  if (out == null && inp == null) return null; // unknown, not free
  const blended = (Number(inp ?? 0) + Number(out ?? 0) * 3) / 4;
  if (blended <= 0) return 1;
  // $0.10/MTok blended -> ~1.0, $30/MTok -> ~0.0
  return Math.max(0, Math.min(1, 1 - Math.log10(blended / 0.1) / Math.log10(300)));
}

export function clearCache() {
  _cache = { at: 0, models: null };
}
