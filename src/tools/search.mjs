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

/**
 * Per-provider politeness throttle.
 *
 * An agent fires searches in bursts - five queries in as many seconds while it
 * explores. The keyless providers answer that with an empty page rather than an
 * error code, which reads as "no results" and sends the agent off to reword the
 * query, which makes it worse. Measured: DuckDuckGo started returning empty
 * results for every query part-way through a research run.
 *
 * Spacing requests fixes the cause. It costs a second or two per search, which
 * is nothing next to a model turn.
 */
const lastCallAt = new Map();
/**
 * Pull results out of a Brave results page.
 *
 * Exported so the unit test can drive THIS function rather than a copy of it.
 * The other parsers in this file are tested against reimplementations in the
 * test file, which means those tests can pass while the shipped parser is
 * broken - not a mistake worth repeating.
 *
 * @param {string} html
 * @param {number} count
 */
/**
 * The readable title of a Brave result.
 *
 * The result anchor's own text is the site name, the domain and a breadcrumb
 * before the actual title - observed: "Redis redis.io > home > comparing the
 * best open source vector databases". Handing that to a model as the title
 * wastes tokens and makes results look like near-duplicates of each other.
 */
function braveTitle(anchor, row) {
  const node = row?.querySelector("div[class*='title'], .title, h3, h4");
  const fromNode = (node?.textContent || "").trim();
  if (fromNode) return fromNode.slice(0, 300);
  const raw = (anchor.textContent || "").trim();
  // Breadcrumbs are joined with a chevron; the real title is the last segment.
  const parts = raw.split(/\s*[›❯>]\s*/).filter(Boolean);
  return (parts.length > 1 ? parts[parts.length - 1] : raw).trim().slice(0, 300);
}

export async function parseBraveHtml(html, count = 10) {
  const { parseHTML } = await import("linkedom");
  const { document } = parseHTML(html);
  const out = [];
  // Result anchors carry a hashed Svelte class plus a stable `l1`. The
  // enrichment cards - video carousels, and so on - do not, which is how they
  // get excluded without matching on a hash that changes every deploy.
  for (const a of document.querySelectorAll("a[class~='l1']")) {
    const href = a.getAttribute("href") || "";
    if (!/^https?:/i.test(href)) continue;
    if (/^https?:\/\/(www\.)?(search\.)?brave\.com|bravesoftware/.test(href)) continue;
    const row = a.closest("div[class*='snippet']") ?? a.parentElement?.parentElement ?? a.parentElement;
    out.push({
      title: braveTitle(a, row),
      url: href,
      snippet: (row?.querySelector("div[class*='snippet-description'], .snippet-description, p")?.textContent || "")
        .trim()
        .slice(0, 300),
      published: null,
    });
    if (out.length >= count) break;
  }
  return out;
}

const MIN_INTERVAL_MS = { duckduckgo: 2500, searxng: 1500, bravehtml: 2000, browser: 1500 };

// Public SearXNG instances, tried in order.
//
// Any one of them can be down, rate-limited, or returning an empty page - so
// the list has to be long enough that the whole rotation failing means the
// machine really is throttled rather than that we picked two unlucky hosts.
// Measured 2026-08-27 on a throttled IP: four of the original four returned
// short empty pages while opnxng returned 33 results for the same query, which
// is why the order below leads with the ones that answered.
const SEARXNG_INSTANCES = [
  "https://opnxng.com",
  "https://searxng.site",
  "https://baresearch.org",
  "https://searx.be",
  "https://priv.au",
  "https://search.inetol.net",
  "https://searx.tiekoetter.com",
];


async function throttle(providerId) {
  const min = MIN_INTERVAL_MS[providerId];
  if (!min) return;
  const last = lastCallAt.get(providerId) ?? 0;
  const wait = last + min - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt.set(providerId, Date.now());
}

/** Distinguishes "blocked/throttled" from "genuinely nothing matched". */
class RateLimited extends Error {
  constructor(provider) {
    super(`${provider} returned an empty page, which is how it signals throttling`);
    this.name = "RateLimited";
    this.provider = provider;
  }
}

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
      // An empty page from DDG's HTML endpoint means throttled, not "no such
      // page on the internet". Saying so lets the caller fall through to the
      // next provider instead of rewording the query forever.
      if (!out.length) throw new RateLimited("duckduckgo");
      return out;
    },
  },

  searxng: {
    // A keyless provider with a genuinely INDEPENDENT path to results, so it
    // does not fail at the same moment and for the same reason as DuckDuckGo -
    // which is exactly what happened during a research run, when DDG began
    // returning empty pages to every query from this machine.
    //
    // SearXNG is self-hostable metasearch; these are public instances, tried in
    // order because any one of them can be down, rate-limited or have its JSON
    // API disabled (measured: 403 and 429 from two of them, while their HTML
    // endpoints answered normally). Point `SEARXNG_INSTANCE` at your own
    // instance to stop depending on volunteers.
    credential: () => "keyless",
    async run(query, { count }) {
      const configured = process.env.SEARXNG_INSTANCE;
      const instances = configured
        ? [configured.replace(/\/$/, "")]
        : SEARXNG_INSTANCES;
      const { parseHTML } = await import("linkedom");
      let lastErr = null;

      for (const base of instances) {
        try {
          const res = await request(`${base}/search?q=${encodeURIComponent(query)}&language=en-US&safesearch=0`, {
            method: "GET",
            headers: { "user-agent": UA, accept: "text/html" },
            timeoutMs: 25_000,
            retries: 0,
          });
          if (!res.ok) {
            lastErr = new Error(`${base} ${res.status}`);
            continue;
          }
          const { document } = parseHTML(await res.text());
          const out = [];
          for (const el of document.querySelectorAll("article.result, .result")) {
            const a = el.querySelector("h3 a, a.url_header");
            if (!a) continue;
            const href = a.getAttribute("href") || "";
            if (!/^https?:/i.test(href)) continue;
            out.push({
              title: (el.querySelector("h3")?.textContent || a.textContent || "").trim(),
              url: href,
              snippet: (el.querySelector("p.content, .content")?.textContent || "").trim().slice(0, 300),
              published: null,
            });
            if (out.length >= count) break;
          }
          if (out.length) return out;
          lastErr = new RateLimited(`searxng(${base})`);
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr ?? new RateLimited("searxng");
    },
  },

  bravehtml: {
    // Brave's own public results page, no key required.
    //
    // Worth having because it is an INDEPENDENT crawler - not a Google or Bing
    // reseller - so it does not go down at the same moment, for the same
    // reason, as DuckDuckGo. Measured 2026-08-27 on an IP that DuckDuckGo was
    // already throttling: 276KB and 34 real result links.
    //
    // This is the ordinary public page fetched with an ordinary user agent. No
    // CAPTCHA is solved and no bot check is defeated; if the page comes back
    // empty that is treated as throttling and the chain moves on, exactly as
    // with every other keyless provider here.
    credential: () => "keyless",
    async run(query, { count }) {
      const res = await request(`https://search.brave.com/search?q=${encodeURIComponent(query)}`, {
        method: "GET",
        headers: { "user-agent": UA, accept: "text/html", "accept-language": "en-US,en;q=0.9" },
        timeoutMs: 25_000,
        retries: 0,
      });
      if (!res.ok) throw new Error(`brave-html ${res.status}`);
      const out = await parseBraveHtml(await res.text(), count);
      if (!out.length) throw new RateLimited("bravehtml");
      return out;
    },
  },

  browser: {
    // Last-resort keyless search: run the query in the real browser we already
    // ship. Slower (a few seconds) but it survives the plain-HTTP endpoint being
    // throttled, which is the failure that actually happens during a research
    // run. Tried only after the cheap paths, and never when a keyed provider
    // is configured.
    //
    // (Mojeek was tried here first and dropped: its search page is a 5 KB
    // JavaScript shell over HTTP and carries no results without rendering.)
    credential: () => "keyless",
    async run(query, { count }) {
      const { renderPage } = await import("./browser-proxy.mjs");
      const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&ia=web`;
      const rendered = await renderPage(url, { timeoutMs: 45_000 });
      const { parseHTML } = await import("linkedom");
      const { document } = parseHTML(rendered.html);
      const out = [];
      const seen = new Set();
      for (const a of document.querySelectorAll('a[data-testid="result-title-a"], article a[href^="http"], h2 a[href^="http"]')) {
        let href = a.getAttribute("href") || "";
        const m = /[?&]uddg=([^&]+)/.exec(href);
        if (m) href = decodeURIComponent(m[1]);
        if (!/^https?:/i.test(href)) continue;
        if (/^https?:\/\/(?:[a-z0-9-]+\.)?duckduckgo\.com\//i.test(href)) continue;
        if (seen.has(href)) continue;
        seen.add(href);
        const article = a.closest("article");
        out.push({
          title: (a.textContent || "").trim(),
          url: href,
          snippet: (article?.querySelector('[data-result="snippet"], span')?.textContent || "").trim().slice(0, 300),
          published: null,
        });
        if (out.length >= count) break;
      }
      if (!out.length) throw new RateLimited("browser");
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
      await throttle(id);
      const results = dedupe(await p.run(query, { count, key })).slice(0, count);
      if (!results.length) {
        attempted.push({ provider: id, ok: false, error: "no results" });
        continue;
      }
      log.info("search ok", { provider: id, query, n: results.length });
      return { query, provider: id, kind: "search-snippets", results, attempted };
    } catch (err) {
      log.warn("search provider failed", { provider: id, err: err.message });
      attempted.push({ provider: id, ok: false, error: err.message, throttled: err instanceof RateLimited });
    }
  }

  const detail = attempted.map((a) => `${a.provider}: ${a.error}`).join("; ");
  // Throttling and "this does not exist" need different responses from the
  // caller, so the error says which one happened.
  if (attempted.length && attempted.every((a) => a.throttled)) {
    throw new Error(
      `every keyless search provider is currently throttling this machine (${detail}). ` +
        `Wait a minute before searching again, or fetch a known URL directly instead. ` +
        `Configuring a search API key removes this limit entirely.`
    );
  }
  throw new Error(`all search providers failed (${detail})`);
}
