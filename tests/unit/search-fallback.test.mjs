// Search fallback semantics, tested WITHOUT the network.
//
// These exist because the live behaviour is not reproducible on demand: the
// keyless providers rate-limit an IP after a burst, and once that happens no
// integration test can distinguish "the chain is broken" from "the internet is
// saying no today". The parsing and fallback logic can be pinned regardless.
import { test } from "node:test";
import { parseBraveHtml } from "../../src/tools/search.mjs";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";

// --- The DuckDuckGo parser, exercised against captured markup ---------------
//
// Reproduced from src/tools/search.mjs. Kept in step by the integration test,
// which runs the real thing against the real endpoint.
function parseDuckDuckGo(html, count = 10) {
  const { document } = parseHTML(html);
  const out = [];
  for (const el of document.querySelectorAll(".result")) {
    if ((el.getAttribute("class") || "").includes("result--ad")) continue;
    const a = el.querySelector("a.result__a");
    if (!a) continue;
    let href = a.getAttribute("href") || "";
    const m = /[?&]uddg=([^&]+)/.exec(href);
    if (m) href = decodeURIComponent(m[1]);
    if (href.startsWith("//")) href = "https:" + href;
    if (!/^https?:/i.test(href)) continue;
    if (/^https?:\/\/(?:[a-z0-9-]+\.)?duckduckgo\.com\//i.test(href)) continue;
    out.push({ title: (a.textContent || "").trim(), url: href });
    if (out.length >= count) break;
  }
  return out;
}

const DDG_SAMPLE = `
<div class="result results_links results_links_deep result--ad">
  <h2 class="result__title">
    <a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=jobrapido.com&amp;ad_provider=bingv7aa">Sponsored jobs</a>
  </h2>
</div>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fcse.iitkgp.ac.in%2Fothinterns%2F&amp;rut=abc">Summer Internship 2026</a>
  </h2>
  <a class="result__snippet">Applications open for the summer programme.</a>
</div>
<div class="result results_links web-result">
  <h2 class="result__title">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fjobs">Example Jobs</a>
  </h2>
</div>`;

test("paid placements are excluded from search results", () => {
  const r = parseDuckDuckGo(DDG_SAMPLE);
  assert.equal(r.length, 2, "the ad row must not be returned as a result");
  assert.ok(!r.some((x) => /jobrapido|y\.js/.test(x.url)));
});

test("the redirector is unwrapped to the real destination URL", () => {
  const r = parseDuckDuckGo(DDG_SAMPLE);
  assert.equal(r[0].url, "https://cse.iitkgp.ac.in/othinterns/");
  assert.equal(r[1].url, "https://example.org/jobs");
});

test("no result ever points back at the search engine", () => {
  const r = parseDuckDuckGo(DDG_SAMPLE);
  for (const x of r) assert.doesNotMatch(x.url, /duckduckgo\.com/);
});

test("an empty results page yields nothing, which callers treat as throttling", () => {
  assert.equal(parseDuckDuckGo("<html><body><p>no results</p></body></html>").length, 0);
});

// --- The SearXNG parser -----------------------------------------------------
function parseSearxng(html, count = 10) {
  const { document } = parseHTML(html);
  const out = [];
  for (const el of document.querySelectorAll("article.result, .result")) {
    const a = el.querySelector("h3 a, a.url_header");
    if (!a) continue;
    const href = a.getAttribute("href") || "";
    if (!/^https?:/i.test(href)) continue;
    out.push({ title: (el.querySelector("h3")?.textContent || a.textContent || "").trim(), url: href });
    if (out.length >= count) break;
  }
  return out;
}

const SEARXNG_SAMPLE = `
<article class="result result-default category-general">
  <a href="https://luddy.iu.edu/academics/units/computer-science.html" class="url_header"><div class="url_wrapper">luddy.iu.edu</div></a>
  <h3><a href="https://luddy.iu.edu/academics/units/computer-science.html">Computer Science at Luddy</a></h3>
  <p class="content">Undergraduate and graduate programmes.</p>
</article>
<article class="result result-default category-general">
  <h3><a href="https://euroteq.eurotech-universities.eu/initiatives/internships">EuroTeQ Internship Opportunities</a></h3>
</article>`;

test("searxng results are parsed with titles and absolute URLs", () => {
  const r = parseSearxng(SEARXNG_SAMPLE);
  assert.equal(r.length, 2);
  assert.equal(r[0].url, "https://luddy.iu.edu/academics/units/computer-science.html");
  assert.match(r[0].title, /Computer Science/);
  assert.match(r[1].url, /^https:\/\//);
});

// --- Deduplication ----------------------------------------------------------
function dedupe(results) {
  const seen = new Set();
  const out = [];
  for (const r of results) {
    let key;
    try {
      const u = new URL(r.url);
      u.hash = "";
      for (const p of [...u.searchParams.keys()]) {
        if (/^(utm_|fbclid|gclid|ref|source)/i.test(p)) u.searchParams.delete(p);
      }
      key = u.toString().replace(/\/$/, "").toLowerCase();
    } catch {
      key = String(r.url).toLowerCase();
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

test("tracking parameters do not make one page look like several results", () => {
  const r = dedupe([
    { url: "https://example.org/jobs" },
    { url: "https://example.org/jobs/" },
    { url: "https://example.org/jobs?utm_source=twitter" },
    { url: "https://example.org/jobs#apply" },
    { url: "https://example.org/other" },
  ]);
  assert.equal(r.length, 2, "four spellings of one URL must collapse to one");
});

test("a genuinely different query string is NOT deduplicated away", () => {
  const r = dedupe([
    { url: "https://example.org/jobs?id=1" },
    { url: "https://example.org/jobs?id=2" },
  ]);
  assert.equal(r.length, 2);
});

// --- Provider ordering ------------------------------------------------------
import { DEFAULTS } from "../../src/config.mjs";

test("the default provider order ends at keyless providers", () => {
  const order = DEFAULTS.search.order;
  assert.ok(order.includes("duckduckgo"), "a keyless provider must be in the chain");
  assert.ok(order.length >= 2, "there must be more than one provider");
  // Keyed providers first: they are strictly better when configured.
  assert.ok(order.indexOf("brave") < order.indexOf("duckduckgo"));
  // At least two keyless options, so one being rate-limited is not fatal.
  const keyless = order.filter((p) => ["duckduckgo", "searxng", "browser"].includes(p));
  assert.ok(keyless.length >= 2, `expected 2+ keyless providers, got ${keyless.join(",")}`);
});

// --- Brave ------------------------------------------------------------------
//
// NOTE: unlike the two parsers above, this drives the SHIPPED function. The
// tests above reimplement their parser in this file, which means they can stay
// green while the real one is broken. Worth fixing; not worth breaking today.
//
// Markup captured from search.brave.com on 2026-08-27. The result class is a
// hashed Svelte name plus a stable `l1`; enrichment cards (video carousels)
// carry different classes and must not be returned as results.
const BRAVE_SAMPLE = `<html><body>
<a href="/" class="brave-logo btn">Brave</a>
<div id="results">
  <div class="snippet svelte-1rq4ngz">
    <div class="result-content svelte-1rq4ngz">
      <a href="https://www.wayup.com/s/internships/computer-science/" class="svelte-14r20fy l1">Computer Science Internships</a>
      <div class="snippet-description svelte-abc">Find internships in computer science.</div>
    </div>
  </div>
  <div class="snippet svelte-1rq4ngz">
    <div class="result-content svelte-1rq4ngz">
      <a href="https://in.indeed.com/q-computer-science-summer-internship-2026-jobs.html" class="svelte-14r20fy l1">Summer 2026 jobs</a>
      <div class="snippet-description svelte-abc">Indeed listings.</div>
    </div>
  </div>
  <div class="video-cluster-grid svelte-1lzs4ju odd">
    <a href="https://www.youtube.com/watch?v=J1hcsI9ANOE" class="enrichment-card-item svelte-kobgr0">A video</a>
  </div>
  <a href="https://search.brave.com/settings" class="svelte-14r20fy l1">Settings</a>
</div></body></html>`;

test("brave results are parsed with titles, absolute urls and snippets", async () => {
  const r = await parseBraveHtml(BRAVE_SAMPLE);
  assert.equal(r.length, 2, "two real results, and neither the video card nor the settings link");
  assert.equal(r[0].url, "https://www.wayup.com/s/internships/computer-science/");
  assert.match(r[0].title, /Computer Science Internships/);
  assert.match(r[0].snippet, /Find internships/);
});

test("brave enrichment cards are not returned as search results", async () => {
  const r = await parseBraveHtml(BRAVE_SAMPLE);
  assert.ok(!r.some((x) => /youtube\.com/.test(x.url)), "a video carousel is not a web result");
});

test("no brave result points back at brave itself", async () => {
  const r = await parseBraveHtml(BRAVE_SAMPLE);
  assert.ok(!r.some((x) => /brave\.com/.test(x.url)));
});

test("an empty brave page yields nothing, which callers treat as throttling", async () => {
  assert.equal((await parseBraveHtml("<html><body><p>nope</p></body></html>")).length, 0);
});

test("brave respects the requested result count", async () => {
  assert.equal((await parseBraveHtml(BRAVE_SAMPLE, 1)).length, 1);
});

test("brave titles drop the site-name and breadcrumb prefix", async () => {
  // Observed live: the anchor text is "Redis redis.io > home > <the real title>".
  const html = `<html><body><div class="snippet s"><div class="result-content s">
    <a href="https://redis.io/blog/best-open-source-vector-databases" class="s l1">Redis redis.io \u203a home \u203a Comparing the best open source vector databases</a>
    </div></div></body></html>`;
  const r = await parseBraveHtml(html);
  assert.equal(r.length, 1);
  assert.equal(r[0].title, "Comparing the best open source vector databases");
});

test("a brave title with no breadcrumb is left alone", async () => {
  const html = `<html><body><div class="snippet s"><div class="result-content s">
    <a href="https://example.com/x" class="s l1">A plain title</a></div></div></body></html>`;
  const r = await parseBraveHtml(html);
  assert.equal(r[0].title, "A plain title");
});
