// Web search with pluggable providers.
//
// The product must work the moment it is installed, so the default chain ends
// at a keyless provider (DuckDuckGo's HTML endpoint). Keyed providers are
// strictly better when configured, so they are tried first.
//
// Every result carries the provider that produced it and is explicitly labelled
// a *snippet*: search snippets are not verified page content, and the skills
// instruct the agent to fetch before asserting.
import { request } from "../util/http.mjs";
import { logger } from "../util/log.mjs";
import { loadConfig } from "../config.mjs";
import { resolveSecret } from "../util/secrets.mjs";

const log = logger("search");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function dedupe(results) {
  const seen = new Set();
  const out = [];
  for (const r of results) {
    let key;
    try {
      const u = new URL(r.url);
      u.hash = "";
      // Strip the tracking params that make one page look like five results.
      for (const p of [...u.searchParams.keys()]) {
        if (/^(utm_|fbclid|gclid|ref|source)/i.test(p)) u.searchParams.delete(p);
      }
      key = u.toString().replace(/\/$/, "").toLowerCase();
    } catch {
      key = String(r.url).toLowerCase();
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...r, url: r.url });
  }
  return out;
}

const PROVIDERS = {
  brave: {
    credential: () => resolveSecret("search.brave", "BRAVE_SEARCH_API_KEY"),
    async run(query, { count, key }) {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
      const res = await request(url, {
        headers: { accept: "application/json", "x-subscription-token": key },
        timeoutMs: 20_000,
      });
      if (!res.ok) throw new Error(`brave ${res.status}`);
      const body = await res.json();
      return (body?.web?.results ?? []).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.description ?? "",
        published: r.age ?? null,
      }));
    },
  },
  tavily: {
    credential: () => resolveSecret("search.tavily", "TAVILY_API_KEY"),
    async run(query, { count, key }) {
      const res = await request("https://api.tavily.com/search", {
        method: "POST",
        idempotent: false,
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ query, max_results: count, search_depth: "basic" }),
        timeoutMs: 30_000,
      });
      if (!res.ok) throw new Error(`tavily ${res.status}`);
      const body = await res.json();
      return (body?.results ?? []).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content ?? "",
        published: r.published_date ?? null,
      }));
    },
  },
  serper: {
    credential: () => resolveSecret("search.serper", "SERPER_API_KEY"),
    async run(query, { count, key }) {
      const res = await request("https://google.serper.dev/search", {
        method: "POST",
        idempotent: false,
        headers: { "content-type": "application/json", "X-API-KEY": key },
        body: JSON.stringify({ q: query, num: count }),
        timeoutMs: 20_000,
      });
      if (!res.ok) throw new Error(`serper ${res.status}`);
      const body = await res.json();
      return (body?.organic ?? []).map((r) => ({
        title: r.title,
        url: r.link,
        snippet: r.snippet ?? "",
        published: r.date ?? null,
      }));
    },
  },
  duckduckgo: {
    // Keyless. This is what makes the product work on a fresh install.
    credential: () => "keyless",
    async run(query, { count }) {
      const res = await request("https://html.duckduckgo.com/html/", {
        method: "POST",
        idempotent: true,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": UA,
          accept: "text/html",
        },
        body: new URLSearchParams({ q: query }).toString(),
        timeoutMs: 25_000,
      });
      if (!res.ok) throw new Error(`duckduckgo ${res.status}`);
      const html = await res.text();
      const { parseHTML } = await import("linkedom");
      const { document } = parseHTML(html);
      const out = [];
      for (const el of document.querySelectorAll(".result")) {
        // Paid placements are not search results and must not be cited as such.
        if ((el.getAttribute("class") || "").includes("result--ad")) continue;
        const a = el.querySelector("a.result__a");
        if (!a) continue;
        let href = a.getAttribute("href") || "";
        // Organic hits are wrapped as //duckduckgo.com/l/?uddg=<encoded>
        const m = /[?&]uddg=([^&]+)/.exec(href);
        if (m) href = decodeURIComponent(m[1]);
        if (href.startsWith("//")) href = "https:" + href;
        if (!/^https?:/i.test(href)) continue;
        // Anything still pointing at DDG is a redirector or an ad, not a source.
        if (/^https?:\/\/(?:[a-z0-9-]+\.)?duckduckgo\.com\//i.test(href)) continue;
        out.push({
          title: (a.textContent || "").trim(),
          url: href,
          snippet: (el.querySelector(".result__snippet")?.textContent || "").trim(),
          published: null,
        });
        if (out.length >= count) break;
      }
      return out;
    },
  },
};

/** Providers that are usable right now, in configured preference order. */
export function availableProviders(cfg = loadConfig()) {
  return cfg.search.order.filter((id) => PROVIDERS[id] && PROVIDERS[id].credential());
}

/**
 * @param {string} query
 * @param {{count?:number, provider?:string}} [opts]
 * @returns {Promise<{query:string, provider:string, kind:"search-snippets", results:Array, attempted:Array}>}
 */
export async function webSearch(query, opts = {}) {
  const cfg = loadConfig();
  const count = Math.min(Math.max(opts.count ?? 10, 1), 25);
  const order = opts.provider ? [opts.provider] : availableProviders(cfg);
  if (!order.length) throw new Error("no search provider available");

  const attempted = [];
  for (const id of order) {
    const p = PROVIDERS[id];
    if (!p) continue;
    const key = p.credential();
    if (!key) {
      attempted.push({ provider: id, ok: false, error: "no credential" });
      continue;
    }
    try {
      const results = dedupe(await p.run(query, { count, key })).slice(0, count);
      if (!results.length) {
        attempted.push({ provider: id, ok: false, error: "no results" });
        continue;
      }
      log.info("search ok", { provider: id, query, n: results.length });
      return { query, provider: id, kind: "search-snippets", results, attempted };
    } catch (err) {
      log.warn("search provider failed", { provider: id, err: err.message });
      attempted.push({ provider: id, ok: false, error: err.message });
    }
  }
  const detail = attempted.map((a) => `${a.provider}: ${a.error}`).join("; ");
  throw new Error(`all search providers failed (${detail})`);
}
