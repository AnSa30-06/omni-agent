// Fetching, readable extraction, scraping and crawling.
//
// Three escalating strategies, cheapest first, because sending every page
// through a real browser is slow and wasteful:
//   builtin   - plain HTTP + Readability. Handles most of the open web.
//   browser   - Playwright render. For JS-heavy pages the builtin path leaves empty.
//   firecrawl - a paid API, used only when the user has configured a key.
//
// Everything returns the final resolved URL alongside the content, because a
// citation naming the pre-redirect URL is a wrong citation.
import { request } from "../util/http.mjs";
import { logger } from "../util/log.mjs";
import { loadConfig } from "../config.mjs";
import { resolveSecret } from "../util/secrets.mjs";

const log = logger("web");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const BINARY_HINT = /\.(pdf|docx?|xlsx?|pptx?|zip|png|jpe?g|gif|webp|mp4|mp3|wav|csv)(\?|$)/i;

let _turndown = null;
async function turndown() {
  if (_turndown) return _turndown;
  const { default: TurndownService } = await import("turndown");
  _turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  _turndown.remove(["script", "style", "noscript", "iframe", "svg"]);
  return _turndown;
}

/** Readability + Turndown over raw HTML. */
export async function htmlToArticle(html, url) {
  const { parseHTML } = await import("linkedom");
  const { Readability } = await import("@mozilla/readability");
  const dom = parseHTML(html);
  const doc = dom.document;
  try {
    Object.defineProperty(doc, "baseURI", { value: url, configurable: true });
  } catch {}

  const links = [];
  for (const a of doc.querySelectorAll("a[href]")) {
    try {
      const abs = new URL(a.getAttribute("href"), url).toString();
      const text = (a.textContent || "").trim();
      if (/^https?:/i.test(abs)) links.push({ text: text.slice(0, 120), url: abs });
    } catch {}
  }

  const title = (doc.querySelector("title")?.textContent || "").trim();
  let article = null;
  try {
    article = new Readability(doc.cloneNode(true)).parse();
  } catch (err) {
    log.debug("readability failed", { url, err: err.message });
  }

  const td = await turndown();
  const bodyHtml = article?.content || doc.querySelector("body")?.innerHTML || "";
  let markdown = "";
  try {
    markdown = td.turndown(bodyHtml);
  } catch {
    markdown = (doc.querySelector("body")?.textContent || "").trim();
  }
  markdown = markdown.replace(/\n{3,}/g, "\n\n").trim();

  return {
    title: article?.title || title || null,
    byline: article?.byline || null,
    excerpt: article?.excerpt || null,
    markdown,
    text: (article?.textContent || doc.querySelector("body")?.textContent || "").replace(/\s+\n/g, "\n").trim(),
    links,
  };
}

/**
 * Fetch one URL and return readable content.
 * @param {string} url
 * @param {{format?:"markdown"|"text"|"html", maxChars?:number, render?:boolean}} [opts]
 */
export async function webFetch(url, opts = {}) {
  const format = opts.format ?? "markdown";
  const maxChars = opts.maxChars ?? 40000;

  if (opts.render) return scrapeUrl(url, { ...opts, provider: "browser" });

  const res = await request(url, {
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
    timeoutMs: 30000,
    redirect: "follow",
  });
  const finalUrl = res.url || url;
  const contentType = res.headers.get("content-type") || "";
  const status = res.status;

  if (!res.ok) {
    return { ok: false, url, finalUrl, status, contentType, error: "HTTP " + status };
  }

  // Binary payloads are the document tools' job, not the HTML extractor's.
  const textual = /text\/html|application\/xhtml|text\/plain|application\/json|text\/markdown/i.test(contentType);
  if (!textual || BINARY_HINT.test(finalUrl)) {
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      ok: true,
      url,
      finalUrl,
      status,
      contentType,
      kind: "binary",
      bytes: buf.length,
      note: "Binary or non-HTML content. Use document_read to extract it.",
    };
  }

  const body = await res.text();
  if (/application\/json/i.test(contentType)) {
    return { ok: true, url, finalUrl, status, contentType, kind: "json", content: body.slice(0, maxChars) };
  }
  if (!/html/i.test(contentType)) {
    return { ok: true, url, finalUrl, status, contentType, kind: "text", content: body.slice(0, maxChars) };
  }

  const article = await htmlToArticle(body, finalUrl);
  const content = format === "html" ? body : format === "text" ? article.text : article.markdown;
  const truncated = content.length > maxChars;
  return {
    ok: true,
    url,
    finalUrl,
    status,
    contentType,
    kind: "article",
    title: article.title,
    byline: article.byline,
    excerpt: article.excerpt,
    content: truncated ? content.slice(0, maxChars) : content,
    truncated,
    links: article.links.slice(0, 200),
    // "Thin" is meant to detect a JavaScript shell: a big HTML payload that
    // yields almost no text. Length alone is not enough - example.com is a
    // complete, correct page with ~149 characters, and a bare length test sent
    // it to the browser every time, turning a 700 ms fetch into an 8 s one.
    // A real SPA shell is kilobytes of script around an empty root node.
    thin: article.text.length < 200 && body.length > 4000,
  };
}

/** Scrape one URL, choosing and escalating strategy. */
export async function scrapeUrl(url, opts = {}) {
  const cfg = loadConfig();
  const order = opts.provider ? [opts.provider] : cfg.scrape.order;
  const attempted = [];

  for (const provider of order) {
    try {
      if (provider === "builtin") {
        const r = await webFetch(url, { ...opts, render: false });
        if (r.ok && r.kind === "article" && r.thin) {
          attempted.push({ provider, ok: false, error: "page rendered thin, escalating" });
          continue;
        }
        if (!r.ok) {
          attempted.push({ provider, ok: false, error: r.error });
          continue;
        }
        return { ...r, provider, attempted };
      }

      if (provider === "browser") {
        const { renderPage } = await import("./browser.mjs");
        const rendered = await renderPage(url, { timeoutMs: opts.timeoutMs });
        const article = await htmlToArticle(rendered.html, rendered.finalUrl);
        return {
          ok: true,
          provider,
          url,
          finalUrl: rendered.finalUrl,
          status: rendered.status,
          kind: "article",
          title: article.title || rendered.title,
          content: opts.format === "text" ? article.text : article.markdown,
          links: article.links.slice(0, 200),
          attempted,
        };
      }

      if (provider === "firecrawl") {
        const key = resolveSecret("scrape.firecrawl", "FIRECRAWL_API_KEY");
        if (!key) {
          attempted.push({ provider, ok: false, error: "no credential" });
          continue;
        }
        const res = await request("https://api.firecrawl.dev/v2/scrape", {
          method: "POST",
          idempotent: false,
          headers: { "content-type": "application/json", authorization: "Bearer " + key },
          body: JSON.stringify({ url, formats: ["markdown"] }),
          timeoutMs: 90000,
        });
        if (!res.ok) {
          attempted.push({ provider, ok: false, error: "firecrawl " + res.status });
          continue;
        }
        const body = await res.json();
        return {
          ok: true,
          provider,
          url,
          finalUrl: body?.data?.metadata?.sourceURL || url,
          kind: "article",
          title: body?.data?.metadata?.title ?? null,
          content: body?.data?.markdown ?? "",
          attempted,
        };
      }
    } catch (err) {
      attempted.push({ provider, ok: false, error: err.message });
    }
  }
  return { ok: false, url, error: "all scrape providers failed", attempted };
}

/** Breadth-first crawl within one host. */
export async function crawlSite(startUrl, opts = {}) {
  const cfg = loadConfig();
  const maxPages = Math.min(opts.maxPages ?? cfg.scrape.maxCrawlPages, 100);
  const sameHostOnly = opts.sameHostOnly ?? true;
  const include = opts.includePattern ? new RegExp(opts.includePattern, "i") : null;
  const start = new URL(startUrl);

  const queue = [start.toString()];
  const seen = new Set([start.toString()]);
  const pages = [];
  const errors = [];

  while (queue.length && pages.length < maxPages) {
    const url = queue.shift();
    let r;
    try {
      r = await webFetch(url, { format: "markdown", maxChars: opts.maxChars ?? 12000 });
    } catch (err) {
      errors.push({ url, error: err.message });
      continue;
    }
    if (!r.ok || r.kind !== "article") {
      errors.push({ url, error: r.error || "not an article (" + r.kind + ")" });
      continue;
    }
    pages.push({ url: r.finalUrl, title: r.title, content: r.content });

    for (const link of r.links || []) {
      if (seen.size >= maxPages * 12) break;
      let u;
      try {
        u = new URL(link.url);
      } catch {
        continue;
      }
      u.hash = "";
      const key = u.toString();
      if (seen.has(key)) continue;
      if (sameHostOnly && u.host !== start.host) continue;
      if (include && !include.test(key)) continue;
      if (BINARY_HINT.test(key)) continue;
      seen.add(key);
      queue.push(key);
    }
  }
  return {
    startUrl,
    pages,
    pageCount: pages.length,
    errors,
    discovered: seen.size,
    stoppedBecause: pages.length >= maxPages ? "maxPages" : "queue-empty",
  };
}
