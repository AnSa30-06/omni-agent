// Executing a model request, with routing, fallback and telemetry.
//
// This is the only place in the product that calls a model, so it is the only
// place that has to get retry semantics right.
//
// Fallback is NOT the same as retry. `request()` already retries a 429 against
// the SAME model with backoff, which is correct for a transient blip. What this
// adds is walking to a DIFFERENT model when one upstream is exhausted - which is
// the common case on the free pool, where retrying the same combo just waits for
// the same rate limit.
import { GatewayClient } from "../gateway/client.mjs";
import { HttpError } from "../util/http.mjs";
import { selectModel, fallbackChain } from "./select.mjs";
import { recordCall } from "../usage/telemetry.mjs";
import { loadConfig } from "../config.mjs";
import { logger } from "../util/log.mjs";

const log = logger("execute");

/** Statuses where trying a different model is more useful than trying again. */
const SWITCH_MODEL = new Set([402, 403, 429, 500, 502, 503, 504]);

function isSwitchWorthy(err) {
  if (err instanceof HttpError) return SWITCH_MODEL.has(err.status);
  // A hard timeout on one upstream is also a reason to try another.
  return /timeout|aborted|fetch failed|ECONNRESET|socket hang up/i.test(err?.message ?? "");
}

/**
 * Run one completion, routing and falling back as needed.
 *
 * @param {{
 *   messages: Array,
 *   task?: string,
 *   mode?: string,
 *   model?: string,
 *   tools?: Array,
 *   maxTokens?: number,
 *   needsTools?: boolean,
 *   needsVision?: boolean,
 *   contextNeeded?: number,
 *   timeoutMs?: number,
 *   client?: GatewayClient
 * }} req
 */
export async function complete(req) {
  const cfg = loadConfig();
  const client = req.client ?? new GatewayClient();

  let chain;
  let routing = null;
  if (req.model) {
    chain = [req.model];
  } else {
    const fc = await fallbackChain({
      task: req.task,
      mode: req.mode,
      needsTools: req.needsTools ?? !!req.tools?.length,
      needsVision: req.needsVision,
      contextNeeded: req.contextNeeded,
    });
    routing = fc.primary;
    chain = fc.chain;
  }

  const attempts = [];
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    try {
      const r = await client.chat({
        model,
        messages: req.messages,
        tools: req.tools,
        maxTokens: req.maxTokens ?? 2048,
        timeoutMs: req.timeoutMs ?? 300000,
      });
      recordCall({
        requested: model,
        servedBy: r.servedBy,
        routingMode: req.mode ?? cfg.routing.mode,
        task: req.task ?? null,
        usage: r.usage,
        latencyMs: r.latencyMs,
        toolCalls: r.toolCalls?.length ?? 0,
      });
      attempts.push({ model, ok: true });
      return {
        ...r,
        routing,
        attempts,
        // Say plainly when the answer did not come from the first choice.
        fellBackFrom: i > 0 ? chain.slice(0, i) : null,
      };
    } catch (err) {
      const status = err instanceof HttpError ? err.status : null;
      attempts.push({ model, ok: false, status, error: err.message });
      recordCall({
        requested: model,
        routingMode: req.mode ?? cfg.routing.mode,
        task: req.task ?? null,
        error: err.message,
      });
      const last = i === chain.length - 1;
      if (last || !isSwitchWorthy(err)) {
        const detail = attempts.map((a) => `${a.model}: ${a.ok ? "ok" : a.status ?? a.error}`).join("; ");
        const e = new Error(
          `model request failed after ${attempts.length} attempt(s) - ${detail}`
        );
        e.attempts = attempts;
        e.cause = err;
        throw e;
      }
      log.warn("falling back to next model", { from: model, to: chain[i + 1], status });
    }
  }
  throw new Error("no models available");
}

/** Convenience for one-shot prompts. */
export async function ask(prompt, opts = {}) {
  const r = await complete({
    messages: [{ role: "user", content: prompt }],
    ...opts,
  });
  return r;
}

export { selectModel };
