// Provider usage / balance / quota adapters.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: never state a number the provider did
// not give us. Every adapter returns one of three states -
//
//   { state: "live",        ... , fetchedAt }   we just read it from the provider
//   { state: "unavailable", reason, remedy }    the provider has no such API, or
//                                               the key we hold cannot read it
//   { state: "error",       reason }            the call failed
//
// and the cache layer adds a fourth, "cached", with the age of the value. There
// is deliberately no code path that produces a plausible-looking default.
//
// Semantics are preserved, not flattened: DeepSeek reports a *money balance*,
// OpenRouter reports *credits used against a credit limit*, Anthropic's Admin
// API reports *tokens consumed*. The UI renders what each one actually is.
import { request } from "../util/http.mjs";
import { logger } from "../util/log.mjs";
import { resolveSecret } from "../util/secrets.mjs";

const log = logger("usage-adapters");

const unavailable = (reason, remedy) => ({ state: "unavailable", reason, remedy: remedy ?? null });

async function json(url, opts) {
  const res = await request(url, { timeoutMs: 20000, retries: 1, ...opts });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, body, headers: res.headers, text };
}

/**
 * Each adapter implements the same optional-field contract:
 *   getBalance() getUsage() getQuota() getRateLimits() getResetTime()
 * Adapters omit what their provider does not expose.
 */
export const ADAPTERS = {
  // -------------------------------------------------------------------------
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    secretName: "provider.deepseek",
    envVar: "DEEPSEEK_API_KEY",
    docs: "https://api-docs.deepseek.com/api/get-user-balance",
    async getBalance(key) {
      const r = await json("https://api.deepseek.com/user/balance", {
        headers: { authorization: "Bearer " + key, accept: "application/json" },
      });
      if (r.status === 401) return unavailable("key rejected", "Check the DeepSeek API key in Settings.");
      if (!r.ok) return { state: "error", reason: "HTTP " + r.status };
      const info = r.body?.balance_infos?.[0];
      if (!info) return { state: "error", reason: "unexpected response shape" };
      return {
        state: "live",
        // DeepSeek reports money, not tokens. Saying otherwise would be a lie.
        kind: "money-balance",
        currency: info.currency,
        total: Number(info.total_balance),
        granted: Number(info.granted_balance),
        toppedUp: Number(info.topped_up_balance),
        isAvailable: !!r.body.is_available,
        fetchedAt: new Date().toISOString(),
      };
    },
  },

  // -------------------------------------------------------------------------
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    secretName: "provider.openrouter",
    envVar: "OPENROUTER_API_KEY",
    docs: "https://openrouter.ai/docs/api-reference/limits",
    async getBalance(key) {
      const r = await json("https://openrouter.ai/api/v1/key", {
        headers: { authorization: "Bearer " + key, accept: "application/json" },
      });
      if (r.status === 401) return unavailable("key rejected", "Check the OpenRouter API key in Settings.");
      if (!r.ok) return { state: "error", reason: "HTTP " + r.status };
      const d = r.body?.data;
      if (!d) return { state: "error", reason: "unexpected response shape" };
      return {
        state: "live",
        kind: "credit-usage",
        currency: "USD",
        used: d.usage ?? null,
        // `limit: null` from OpenRouter means "no limit set", not "zero left".
        limit: d.limit ?? null,
        remaining: d.limit == null ? null : Number(d.limit) - Number(d.usage ?? 0),
        unlimited: d.limit == null,
        isFreeTier: !!d.is_free_tier,
        rateLimit: d.rate_limit ?? null,
        fetchedAt: new Date().toISOString(),
      };
    },
  },

  // -------------------------------------------------------------------------
  moonshot: {
    id: "moonshot",
    label: "Moonshot / Kimi",
    secretName: "provider.moonshot",
    envVar: "MOONSHOT_API_KEY",
    docs: "https://platform.moonshot.ai/docs/api/misc",
    async getBalance(key) {
      // Two regional hosts; .ai is the international one, .cn the mainland one.
      for (const host of ["https://api.moonshot.ai", "https://api.moonshot.cn"]) {
        try {
          const r = await json(host + "/v1/users/me/balance", {
            headers: { authorization: "Bearer " + key, accept: "application/json" },
          });
          if (r.status === 401) return unavailable("key rejected", "Check the Moonshot API key in Settings.");
          if (!r.ok) continue;
          const d = r.body?.data;
          if (!d) continue;
          return {
            state: "live",
            kind: "money-balance",
            currency: "CNY",
            total: d.available_balance ?? null,
            voucher: d.voucher_balance ?? null,
            cash: d.cash_balance ?? null,
            host,
            fetchedAt: new Date().toISOString(),
          };
        } catch (err) {
          log.debug("moonshot host failed", { host, err: err.message });
        }
      }
      return { state: "error", reason: "no Moonshot host responded" };
    },
  },

  // -------------------------------------------------------------------------
  anthropic: {
    id: "anthropic",
    label: "Anthropic (Claude)",
    secretName: "provider.anthropic",
    envVar: "ANTHROPIC_API_KEY",
    adminSecretName: "provider.anthropic.admin",
    adminEnvVar: "ANTHROPIC_ADMIN_KEY",
    docs: "https://platform.claude.com/docs/en/manage-claude/usage-cost-api",
    async getUsage(key) {
      // Measured constraint: the usage report is an ADMIN-key endpoint. A normal
      // sk-ant-api key gets 401 there, so we do not pretend a normal key can
      // produce usage figures.
      const admin = resolveSecret("provider.anthropic.admin", "ANTHROPIC_ADMIN_KEY");
      if (!admin) {
        return unavailable(
          "Anthropic exposes token usage only through the Admin API",
          "Add an Admin API key (sk-ant-admin-...) from Console > Settings > Admin keys to see usage here."
        );
      }
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const url =
        "https://api.anthropic.com/v1/organizations/usage_report/messages" +
        "?starting_at=" + encodeURIComponent(since) + "&bucket_width=1d&limit=1";
      const r = await json(url, {
        headers: { "x-api-key": admin, "anthropic-version": "2023-06-01", accept: "application/json" },
      });
      if (r.status === 401 || r.status === 403) {
        return unavailable("admin key rejected", "Confirm the key starts with sk-ant-admin- and has usage scope.");
      }
      if (!r.ok) return { state: "error", reason: "HTTP " + r.status };
      const bucket = r.body?.data?.[0];
      const totals = (bucket?.results ?? []).reduce(
        (a, x) => ({
          input: a.input + (x.uncached_input_tokens ?? x.input_tokens ?? 0),
          output: a.output + (x.output_tokens ?? 0),
        }),
        { input: 0, output: 0 }
      );
      return {
        state: "live",
        kind: "token-usage",
        window: "last 24h",
        inputTokens: totals.input,
        outputTokens: totals.output,
        fetchedAt: new Date().toISOString(),
      };
    },
    async getBalance() {
      return unavailable(
        "Anthropic publishes no account-balance API",
        "Credit balance is visible in the Anthropic Console only."
      );
    },
  },

  // -------------------------------------------------------------------------
  openai: {
    id: "openai",
    label: "OpenAI",
    secretName: "provider.openai",
    envVar: "OPENAI_API_KEY",
    adminSecretName: "provider.openai.admin",
    adminEnvVar: "OPENAI_ADMIN_KEY",
    docs: "https://platform.openai.com/docs/api-reference/usage",
    async getUsage() {
      const admin = resolveSecret("provider.openai.admin", "OPENAI_ADMIN_KEY");
      if (!admin) {
        return unavailable(
          "OpenAI exposes usage and cost only through organization Admin keys",
          "Add an Admin key from platform.openai.com > Settings > Admin keys to see usage here."
        );
      }
      const start = Math.floor((Date.now() - 24 * 3600 * 1000) / 1000);
      const r = await json(
        "https://api.openai.com/v1/organization/costs?start_time=" + start + "&limit=1",
        { headers: { authorization: "Bearer " + admin, accept: "application/json" } }
      );
      if (r.status === 401 || r.status === 403) return unavailable("admin key rejected", "Check the OpenAI Admin key.");
      if (!r.ok) return { state: "error", reason: "HTTP " + r.status };
      const results = r.body?.data?.[0]?.results ?? [];
      const amount = results.reduce((a, x) => a + Number(x?.amount?.value ?? 0), 0);
      return {
        state: "live",
        kind: "money-spend",
        window: "last 24h",
        currency: results[0]?.amount?.currency ?? "USD",
        spend: Number(amount.toFixed(4)),
        fetchedAt: new Date().toISOString(),
      };
    },
    async getBalance() {
      return unavailable(
        "OpenAI publishes no supported account-balance API",
        "Balance is visible in the OpenAI billing dashboard only."
      );
    },
  },

  // -------------------------------------------------------------------------
  google: {
    id: "google",
    label: "Google (Gemini)",
    secretName: "provider.google",
    envVar: "GEMINI_API_KEY",
    docs: "https://ai.google.dev/gemini-api/docs/rate-limits",
    async getBalance() {
      return unavailable(
        "Google publishes no balance or quota API for Gemini API keys",
        "Quota and usage are shown in Google AI Studio / Cloud Console only."
      );
    },
    async getQuota() {
      return unavailable(
        "Gemini per-key quota is not exposed over the API",
        "Tier limits are documented at ai.google.dev/gemini-api/docs/rate-limits."
      );
    },
  },
};

/**
 * Query one provider for everything it can report.
 * Returns only what the adapter actually implements.
 */
export async function queryProvider(id) {
  const a = ADAPTERS[id];
  if (!a) return { provider: id, error: "unknown provider" };
  const key = resolveSecret(a.secretName, a.envVar);
  const out = { provider: id, label: a.label, docs: a.docs, configured: !!key };
  if (!key && !a.adminSecretName) {
    out.balance = unavailable("no API key configured", "Add a key in Settings to see live figures.");
    return out;
  }
  for (const [field, method] of [
    ["balance", "getBalance"],
    ["usage", "getUsage"],
    ["quota", "getQuota"],
    ["rateLimits", "getRateLimits"],
  ]) {
    if (typeof a[method] !== "function") continue;
    try {
      out[field] = await a[method](key);
    } catch (err) {
      log.warn("adapter failed", { provider: id, method, err: err.message });
      out[field] = { state: "error", reason: err.message };
    }
  }
  return out;
}

export function configuredProviders() {
  return Object.values(ADAPTERS)
    .filter((a) => resolveSecret(a.secretName, a.envVar) || resolveSecret(a.adminSecretName, a.adminEnvVar))
    .map((a) => a.id);
}

export function allProviderIds() {
  return Object.keys(ADAPTERS);
}
