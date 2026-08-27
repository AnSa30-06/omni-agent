// The gateway, as one tool.
//
// OmniRoute exposes its whole management surface - 104 tools over MCP, or ~200
// REST endpoints - and wiring that in natively would put roughly a hundred tool
// descriptions into every single request. This product's whole tool design is
// eight tools for exactly that reason: a tool description is rent, paid per
// turn, forever.
//
// So the gateway is one tool with an `action`, the same shape the browser uses.
// The agent pays for one description and can still reach everything that
// matters to an end user: what it is running on, what it costs, what is
// connected, and how hard it is compressing.
//
// Actions are an explicit allowlist. The action name arrives from the model, so
// it is never used to build a URL directly - a model that hallucinates
// "settings_delete_everything" gets an unknown-action error, not a request.
import { admin } from "../gateway/admin.mjs";
import { gatewayBaseUrl } from "../config.mjs";
import { status as gatewayStatus } from "../gateway/supervisor.mjs";
import { getSaving, setSaving, measure, TIERS } from "../routing/compression.mjs";
import * as providers from "../setup/providers.mjs";
import { PAGES, dashboardUrl } from "../gateway/dashboard.mjs";

/** Actions that change something the user would want to have agreed to. */
const CONSEQUENTIAL = new Set(["provider_add", "provider_remove", "saving_set"]);

export const ACTIONS = {
  status: "Gateway health, version and address.",
  models: "Every model the gateway can serve right now.",
  usage: "Token usage and cost analytics the gateway has recorded.",
  quota: "Free-tier allowance the gateway reports, and what is left.",
  combos: "The auto/* routing combos and what each is for.",
  saving_get: "The current token-saving tier and what it does.",
  saving_list: "Every saving tier, with savings measured on real payloads.",
  saving_set: "Change the token-saving tier. Needs `tier`.",
  providers_list: "Free providers available, and which are already connected.",
  provider_add: "Connect a provider. Needs `provider`, and `key` unless it is keyless.",
  provider_signin_url: "Get a sign-in URL for a subscription provider. Needs `provider`.",
  provider_remove: "Disconnect a provider. Needs `connectionId`.",
  dashboard_url: "A link to a dashboard page. Optional `page`.",
};

function ok(data) {
  return { ok: true, ...data };
}
function fail(reason, extra = {}) {
  return { ok: false, error: reason, ...extra };
}

/**
 * @param {string} action
 * @param {object} args
 * @param {{confirm?:boolean}} [opts]
 */
export async function runGatewayAction(action, args = {}, opts = {}) {
  if (!Object.hasOwn(ACTIONS, action)) {
    return fail(`unknown action "${action}"`, { known: Object.keys(ACTIONS) });
  }
  if (CONSEQUENTIAL.has(action) && !opts.confirm) {
    return {
      ok: false,
      blocked: true,
      reason: "confirmation-required",
      message:
        `"${action}" changes the user's setup. Tell them exactly what will change and get their ` +
        "agreement for this specific action, then call again with confirm: true.",
    };
  }

  switch (action) {
    case "status": {
      const st = gatewayStatus();
      return ok({ baseUrl: gatewayBaseUrl(), running: st.running, pid: st.pid, dataDir: st.dataDir });
    }

    case "models": {
      const r = await admin("GET", "/api/models/catalog");
      if (!r.ok) return fail(r.reason);
      const cat = r.data?.catalog ?? {};
      const groups = Object.entries(cat).map(([id, v]) => ({
        provider: id,
        active: v?.active ?? null,
        models: (v?.models ?? []).map((m) => m.id),
      }));
      return ok({ providers: groups, total: groups.reduce((n, g) => n + g.models.length, 0) });
    }

    case "usage": {
      const r = await admin("GET", "/api/usage/analytics");
      if (!r.ok) return fail(r.reason);
      return ok({ summary: r.data?.summary ?? null, byModel: r.data?.byModel ?? null });
    }

    case "quota": {
      const r = await admin("GET", "/api/quota/plans");
      if (!r.ok) return fail(r.reason);
      return ok({ quota: r.data });
    }

    case "combos": {
      const r = await admin("GET", "/api/combos");
      if (!r.ok) return fail(r.reason);
      const rows = (r.data?.combos ?? []).map((c) => ({ id: c.id, name: c.name, strategy: c.strategy }));
      return ok({ combos: rows, total: r.data?.total ?? rows.length });
    }

    case "saving_get": {
      const cur = await getSaving();
      if (!cur.ok) return fail(cur.reason);
      return ok({ tier: cur.tier.id, label: cur.tier.label, mode: cur.defaultMode, enabled: cur.enabled });
    }

    case "saving_list": {
      const m = await measure();
      return ok({
        tiers: (m.results ?? TIERS).map((t) => ({
          id: t.id,
          label: t.label,
          targets: t.axis,
          savedPct: t.measured ? t.savedPct : null,
          published: t.published,
          costs: t.costs,
        })),
        measuredOn: m.ok ? m.source : "not-measured",
      });
    }

    case "saving_set": {
      if (!args.tier) return fail("`tier` is required", { choices: TIERS.map((t) => t.id) });
      const r = await setSaving(args.tier);
      if (!r.ok) return fail(r.reason, { choices: TIERS.map((t) => t.id) });
      return ok({ tier: r.tier.id, label: r.tier.label, note: "Applies to every request from now on." });
    }

    case "providers_list": {
      const all = await providers.listAll();
      return ok({
        models: all.models.map((p) => ({ id: p.id, label: p.label, connected: p.connected, gives: p.gives, signup: p.signup })),
        signIn: all.signIn.map((p) => ({ id: p.id, label: p.label, connected: p.connected })),
        search: all.search.map((p) => ({ id: p.id, label: p.label, connected: p.connected, signup: p.signup })),
        note: "`gives` is each provider's own advertised allowance, not a measurement.",
      });
    }

    case "provider_add": {
      if (!args.provider) return fail("`provider` is required");
      // A search key is a local secret, not a gateway connection.
      if (providers.catalogue().search.some((s) => s.id === args.provider)) {
        const r = providers.addSearchKey(args.provider, args.key);
        return r.ok ? ok({ added: args.provider, kind: "search" }) : fail(r.reason);
      }
      const r = await providers.addModelProvider(args.provider, args.key);
      if (!r.ok) return fail(r.reason);
      const t = r.connectionId ? await providers.testConnection(r.connectionId) : null;
      return ok({
        added: r.id,
        connectionId: r.connectionId,
        works: t ? t.ok : null,
        problem: t && !t.ok ? t.error : null,
        remedy: t && !t.ok ? t.remedy : null,
      });
    }

    case "provider_signin_url": {
      if (!args.provider) return fail("`provider` is required");
      const r = await providers.signInUrl(args.provider);
      if (!r.ok) return fail(r.reason);
      return ok({
        url: r.url,
        instruction: "Give this URL to the user to open themselves. Do not attempt the sign-in for them.",
      });
    }

    case "provider_remove": {
      if (!args.connectionId) return fail("`connectionId` is required");
      const r = await providers.removeConnection(args.connectionId);
      return r.ok ? ok({ removed: args.connectionId }) : fail(r.reason);
    }

    case "dashboard_url": {
      const page = args.page ?? "home";
      const url = dashboardUrl(page);
      if (!url) return fail(`unknown page "${page}"`, { pages: Object.keys(PAGES) });
      return ok({
        url,
        page,
        label: PAGES[page].label,
        instruction: "The dashboard asks for a password. Tell the user to run `omni-agent dashboard` to see it.",
      });
    }

    default:
      return fail(`action "${action}" is listed but not implemented`);
  }
}
