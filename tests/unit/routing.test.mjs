import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTiers, capabilityScore, speedScore, costScore } from "../../src/routing/catalog.mjs";
import { selectModel, PRESETS } from "../../src/routing/select.mjs";

/** A synthetic catalogue, so routing is tested without a live gateway. */
function catalogue() {
  const combo = (id, cap, spd) => ({
    id, displayName: id, isCombo: true, contextLength: 200000, maxOutputTokens: 8192,
    capabilities: { toolCalling: true, vision: false, reasoning: true },
    capabilityTier: cap, speedTier: spd, tierSource: "local-estimate",
    recommendedTasks: [], observed: null,
    pricing: { inputPerMTok: null, outputPerMTok: null, source: "unavailable" },
  });
  const model = (id, cap, spd, extra = {}) => ({
    id, displayName: id, isCombo: false, contextLength: 128000, maxOutputTokens: 8192,
    capabilities: { toolCalling: true, vision: false, reasoning: false },
    capabilityTier: cap, speedTier: spd, tierSource: "local-estimate",
    recommendedTasks: [], observed: null,
    pricing: { inputPerMTok: null, outputPerMTok: null, source: "unavailable" },
    ...extra,
  });
  return [
    combo("auto/best-coding", "elite", "medium"),
    combo("auto/pro-coding", "very-strong", "fast"),
    combo("auto/coding", "strong", "fast"),
    combo("auto/coding:fast", "strong", "very-fast"),
    combo("auto/coding:cheap", "medium", "very-fast"),
    combo("auto/cheap", "medium", "very-fast"),
    combo("auto/smart", "very-strong", "medium"),
    combo("auto/chat", "strong", "fast"),
    combo("auto/fast", "medium", "very-fast"),
    combo("auto/best-fast", "strong", "very-fast"),
    model("vendor/big", "elite", "medium", { pricing: { inputPerMTok: 15, outputPerMTok: 60, source: "gateway-pricing-api" } }),
    model("vendor/small", "medium", "very-fast", { pricing: { inputPerMTok: 0.1, outputPerMTok: 0.4, source: "gateway-pricing-api" } }),
  ];
}

test("combo tiers are derived from the naming scheme, not a hardcoded table", () => {
  assert.equal(estimateTiers("auto/best-anything").capability_tier, "elite");
  assert.equal(estimateTiers("auto/pro-anything").capability_tier, "very-strong");
  assert.equal(estimateTiers("auto/coding:cheap").capability_tier, "medium");
  assert.equal(estimateTiers("auto/coding:fast").speed_tier, "very-fast");
  // A combo the metadata file has never heard of still gets a tier.
  assert.equal(estimateTiers("auto/some-future-combo").source, "derived-from-combo-name");
});

test("an unrecognised concrete model is marked unknown rather than guessed into a tier", () => {
  const t = estimateTiers("weird/entirely-unknown-thing-9000");
  assert.equal(t.capability_tier, null);
  assert.equal(t.source, "unknown");
});

test("every preset picks a different combo for the same task", async () => {
  const cat = catalogue();
  const picks = {};
  for (const mode of Object.keys(PRESETS)) {
    const r = await selectModel({ mode, task: "code", needsTools: true, catalogue: cat });
    picks[mode] = r.model;
  }
  assert.equal(picks.quality, "auto/best-coding");
  assert.equal(picks.smart, "auto/pro-coding");
  assert.equal(picks.balanced, "auto/coding");
  assert.equal(picks.fast, "auto/coding:fast");
  assert.equal(picks.cheap, "auto/coding:cheap");
  // The regression this guards: routing mode being ignored once a task is given.
  assert.equal(new Set(Object.values(picks)).size, 5);
});

test("cheap tasks never reach an elite model", async () => {
  const cat = catalogue();
  for (const task of ["classify", "title", "extract-simple"]) {
    const r = await selectModel({ task, catalogue: cat });
    assert.equal(r.model, "auto/cheap", `${task} routed to ${r.model}`);
  }
});

test("a pinned model wins, and a bad pin fails loudly", async () => {
  const cat = catalogue();
  const r = await selectModel({ pinnedModel: "vendor/big", catalogue: cat });
  assert.equal(r.model, "vendor/big");
  assert.equal(r.via, "user-pin");
  await assert.rejects(
    () => selectModel({ pinnedModel: "vendor/does-not-exist", catalogue: cat }),
    /not in the gateway catalogue/
  );
});

test("unknown cost is null, not zero - so it cannot masquerade as free", () => {
  assert.equal(costScore({ pricing: { inputPerMTok: null, outputPerMTok: null } }), null);
  const cheap = costScore({ pricing: { inputPerMTok: 0.1, outputPerMTok: 0.4 } });
  const dear = costScore({ pricing: { inputPerMTok: 15, outputPerMTok: 60 } });
  assert.ok(cheap > dear, "a cheaper model must score higher on cost");
});

test("measured throughput overrides the editorial speed tier once there are samples", () => {
  const editorial = speedScore({ speedTier: "medium", observed: null });
  const measuredFast = speedScore({ speedTier: "medium", observed: { outputTokensPerSec: 120, samples: 5 } });
  const measuredSlow = speedScore({ speedTier: "very-fast", observed: { outputTokensPerSec: 2, samples: 5 } });
  assert.ok(measuredFast > editorial);
  assert.ok(measuredSlow < 0.1, "a model measured at 2 tok/s must not score as very-fast");
});

test("a single sample is not enough to override the tier", () => {
  const one = speedScore({ speedTier: "very-fast", observed: { outputTokensPerSec: 2, samples: 1 } });
  assert.equal(one, 1.0);
});

test("capability scores are ordered", () => {
  const order = ["fast-basic", "medium", "strong", "very-strong", "elite"];
  for (let i = 1; i < order.length; i++) {
    assert.ok(capabilityScore(order[i]) > capabilityScore(order[i - 1]));
  }
});

test("tool-incapable models are excluded when tools are required", async () => {
  const cat = catalogue().map((m) => ({ ...m, capabilities: { ...m.capabilities, toolCalling: false } }));
  cat.push({
    id: "vendor/tools-ok", isCombo: false, contextLength: 128000,
    capabilities: { toolCalling: true, vision: false, reasoning: false },
    capabilityTier: "strong", speedTier: "fast", tierSource: "local-estimate",
    recommendedTasks: [], observed: null, pricing: { source: "unavailable" },
  });
  const r = await selectModel({ needsTools: true, catalogue: cat, mode: "balanced" });
  assert.equal(r.model, "vendor/tools-ok");
});
