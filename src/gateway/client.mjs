// HTTP client for the OmniRoute gateway.
//
// Split deliberately in two: /v1/* is the inference surface and works with no
// credential at all on a default install; /api/* is the management surface and
// returns 401 without a management-scoped key. Callers must be able to tell
// those apart, because "quota unavailable" is a legitimate, displayable state
// and must never be papered over with an invented number.
import { getJson, postJson, request, HttpError } from "../util/http.mjs";
import { logger } from "../util/log.mjs";
import { loadConfig, gatewayBaseUrl } from "../config.mjs";
import { resolveSecret } from "../util/secrets.mjs";

const log = logger("gateway");

export class GatewayClient {
  constructor({ baseUrl, apiKey, managementKey } = {}) {
    const cfg = loadConfig();
    this.baseUrl = (baseUrl || gatewayBaseUrl(cfg)).replace(/\/$/, "");
    this.apiKey = apiKey ?? resolveSecret("omniroute.apiKey", "OMNIROUTE_API_KEY");
    this.managementKey =
      managementKey ?? resolveSecret("omniroute.managementKey", "OMNIROUTE_MANAGEMENT_KEY") ?? this.apiKey;
  }

  #headers(key) {
    const h = { accept: "application/json" };
    if (key) h.authorization = `Bearer ${key}`;
    return h;
  }

  /** True when the gateway process answers at all. Needs no credential. */
  async isUp(timeoutMs = 3_000) {
    try {
      const res = await request(`${this.baseUrl}/api/monitoring/health`, {
        method: "GET",
        timeoutMs,
        retries: 0,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async health() {
    return getJson(`${this.baseUrl}/api/monitoring/health`, { timeoutMs: 10_000, headers: this.#headers() });
  }

  /** Full live catalogue. Never cached here - callers decide their own TTL. */
  async listModels() {
    const body = await getJson(`${this.baseUrl}/v1/models`, {
      timeoutMs: 30_000,
      headers: this.#headers(this.apiKey),
    });
    return Array.isArray(body?.data) ? body.data : [];
  }

  /**
   * One chat completion.
   * Returns the raw body plus normalised usage, so telemetry has a single shape
   * regardless of which upstream served it.
   */
  async chat({ model, messages, tools, maxTokens = 2048, temperature, timeoutMs = 300_000, signal }) {
    const started = Date.now();
    const payload = { model, messages, stream: false, max_tokens: maxTokens };
    if (tools?.length) payload.tools = tools;
    if (temperature != null) payload.temperature = temperature;
    const body = await postJson(`${this.baseUrl}/v1/chat/completions`, payload, {
      timeoutMs,
      signal,
      headers: this.#headers(this.apiKey),
    });
    const usage = body?.usage ?? {};
    return {
      raw: body,
      /** The model OmniRoute actually routed to, which is not always `model`. */
      servedBy: body?.model ?? null,
      requested: model,
      content: body?.choices?.[0]?.message?.content ?? null,
      toolCalls: body?.choices?.[0]?.message?.tool_calls ?? [],
      finishReason: body?.choices?.[0]?.finish_reason ?? null,
      latencyMs: Date.now() - started,
      usage: {
        inputTokens: usage.prompt_tokens ?? null,
        outputTokens: usage.completion_tokens ?? null,
        totalTokens: usage.total_tokens ?? null,
        cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? null,
        reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? null,
        /** Provider-reported, not estimated. Consumers must not blur this. */
        source: usage.total_tokens != null ? "provider" : "unavailable",
      },
    };
  }

  /**
   * Management-scope GET.
   * Returns {ok:false, reason:"unauthorized"} rather than throwing, because a
   * missing management key is the default state of a fresh install and the UI
   * needs to render it as "unavailable", not as an error.
   */
  async management(pathname) {
    if (!this.managementKey) return { ok: false, reason: "no-management-key" };
    try {
      const data = await getJson(`${this.baseUrl}${pathname}`, {
        timeoutMs: 20_000,
        headers: this.#headers(this.managementKey),
      });
      return { ok: true, data };
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        return { ok: false, reason: "unauthorized" };
      }
      log.warn(`management call failed`, { pathname, err: err.message });
      return { ok: false, reason: "error", error: err.message };
    }
  }
}
