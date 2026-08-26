// Live web integration tests: search, fetch, extraction, crawl.
// These hit the real internet on purpose - the whole point is that the
// providers still behave the way the code assumes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { webSearch, availableProviders } from "../../src/tools/search.mjs";
import { webFetch, scrapeUrl, crawlSite, htmlToArticle } from "../../src/tools/web.mjs";

test("at least one search provider is usable with no credentials at all", () => {
  const p = availableProviders();
  assert.ok(p.includes("duckduckgo"), "the keyless fallback must always be available");
});

test("web search returns real, absolute, deduplicated URLs", async () => {
  const r = await webSearch("site:iana.org example domain reserved", { count: 5 });
  assert.ok(r.results.length > 0, "no results");
  const urls = r.results.map((x) => x.url);
  for (const u of urls) {
    assert.match(u, /^https?:\/\//, `not absolute: ${u}`);
    assert.doesNotMatch(u, /duckduckgo\.com/, `redirector leaked into results: ${u}`);
  }
  assert.equal(new Set(urls).size, urls.length, "duplicate URLs were returned");
  assert.equal(r.kind, "search-snippets", "results must be labelled as snippets, not verified content");
});

test("web fetch extracts readable content and reports the final URL", async () => {
  const r = await webFetch("https://example.com/");
  assert.equal(r.ok, true);
  assert.equal(r.kind, "article");
  assert.equal(r.title, "Example Domain");
  assert.match(r.content, /documentation examples/i);
  assert.ok(r.finalUrl.startsWith("https://example.com"), "finalUrl must be reported for citation");
});

test("a redirect is followed and the FINAL url is what gets reported", async () => {
  const r = await webFetch("https://httpbin.org/redirect-to?url=https%3A%2F%2Fexample.com%2F");
  assert.equal(r.ok, true);
  assert.match(r.finalUrl, /example\.com/, "citing the pre-redirect URL would be a wrong citation");
});

test("a 404 is reported as a failure, not as empty content", async () => {
  const r = await webFetch("https://httpbin.org/status/404");
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
});

test("binary content is identified rather than mangled into text", async () => {
  const r = await webFetch("https://httpbin.org/image/png");
  assert.equal(r.ok, true);
  assert.equal(r.kind, "binary");
  assert.ok(r.bytes > 0);
});

test("truncation is explicit, never silent", async () => {
  const r = await webFetch("https://www.iana.org/help/example-domains", { maxChars: 200 });
  if (r.ok && r.kind === "article") {
    assert.ok(r.content.length <= 200);
    assert.equal(r.truncated, true);
  }
});

test("htmlToArticle resolves relative links to absolute ones", async () => {
  const html = '<html><head><title>T</title></head><body><article><p>hello world, this is a body long enough to be extracted by readability without being discarded as boilerplate content.</p><a href="/about">About</a></article></body></html>';
  const a = await htmlToArticle(html, "https://example.org/docs/page");
  assert.equal(a.title, "T");
  assert.ok(a.links.some((l) => l.url === "https://example.org/about"), "relative link was not resolved");
});

test("scrapeUrl reports which strategy it used and what it escalated past", async () => {
  const r = await scrapeUrl("https://example.com/");
  assert.equal(r.ok, true);
  assert.equal(r.provider, "builtin", "an ordinary page must not need the browser");
  assert.ok(Array.isArray(r.attempted));
});

test("crawlSite stays on one host and respects maxPages", async () => {
  const r = await crawlSite("https://www.iana.org/help/example-domains", { maxPages: 3 });
  assert.ok(r.pageCount >= 1, "crawl found nothing");
  assert.ok(r.pageCount <= 3, "maxPages was not respected");
  for (const p of r.pages) assert.match(p.url, /iana\.org/, `left the host: ${p.url}`);
});
