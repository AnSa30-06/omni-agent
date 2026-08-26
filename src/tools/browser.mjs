// Browser automation on Playwright.
//
// Design notes that matter:
//
// * One long-lived browser + context per process, so a multi-step task ("open
//   the form, read the PDF, come back, fill it") keeps its cookies, its tabs
//   and its scroll position between tool calls. A fresh browser per call cannot
//   do interactive work at all.
//
// * Interaction is by *ref*, not by CSS selector. The agent gets a numbered
//   outline of the page and clicks "e12"; it never has to guess a selector.
//   Measured on playwright-core 1.62.1: `page._snapshotForAI()` (what the
//   official Playwright MCP server uses) does not exist in core, and the public
//   `ariaSnapshot({ ref: true })` silently ignores the ref option - its output is
//   byte-identical to `ariaSnapshot()` and carries no refs. So refs come from us:
//   domSnapshot() walks the DOM and stamps `data-omni-ref` as it goes.
//
// * Submitting a form is gated. `click` refuses a submit-shaped control unless
//   the caller passes confirmSubmit:true, which the tool layer only sets when
//   the user has authorised it in that turn. See docs/security.md.
import fs from "node:fs";
import path from "node:path";
import { PATHS, ensureDirs } from "../util/paths.mjs";
import { logger } from "../util/log.mjs";
import { loadConfig } from "../config.mjs";

const log = logger("browser");

let _pw = null;
let _browser = null;
let _context = null;
/** Tabs we opened, in open order, so "tab 2" is stable for the agent. */
let _pages = [];
let _active = 0;

function browsersPath() {
  return PATHS.browsers;
}

async function playwright() {
  if (_pw) return _pw;
  // Point Playwright at our isolated download location before it is imported.
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath();
  _pw = await import("playwright-core");
  return _pw;
}

/** True when a Chromium build is present in our browsers directory. */
export function chromiumInstalled() {
  try {
    const entries = fs.readdirSync(browsersPath());
    return entries.some((e) => /^chromium/.test(e));
  } catch {
    return false;
  }
}

export async function launch({ headless } = {}) {
  if (_browser && _browser.isConnected()) return _browser;
  ensureDirs();
  const cfg = loadConfig();
  const { chromium } = await playwright();
  const opts = {
    headless: headless ?? cfg.browser.headless,
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
  };
  if (cfg.browser.channel) opts.channel = cfg.browser.channel;
  _browser = await chromium.launch(opts);
  _context = await _browser.newContext({
    viewport: { width: 1366, height: 900 },
    acceptDownloads: true,
    ignoreHTTPSErrors: false,
  });
  _context.setDefaultTimeout(cfg.browser.timeoutMs);
  _context.setDefaultNavigationTimeout(cfg.browser.timeoutMs);
  _pages = [];
  _active = 0;
  // Track popups/new tabs the site opens itself.
  _context.on("page", (p) => {
    if (!_pages.includes(p)) _pages.push(p);
  });
  log.info("browser launched", { headless: opts.headless });
  return _browser;
}

export async function close() {
  try {
    if (_context) await _context.close();
  } catch {}
  try {
    if (_browser) await _browser.close();
  } catch {}
  _browser = null;
  _context = null;
  _pages = [];
  _active = 0;
  return { closed: true };
}

async function activePage() {
  await launch();
  if (!_pages.length) {
    const p = await _context.newPage();
    _pages.push(p);
    _active = 0;
  }
  _pages = _pages.filter((p) => !p.isClosed());
  if (!_pages.length) {
    const p = await _context.newPage();
    _pages.push(p);
    _active = 0;
  }
  if (_active >= _pages.length) _active = _pages.length - 1;
  return _pages[_active];
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/**
 * Build the page outline.
 *
 * Measured on playwright-core 1.62.1: `page._snapshotForAI()` does not exist
 * (it lives in the playwright server package, not in core), and the public
 * `ariaSnapshot({ ref: true })` silently ignores the ref option - its output is
 * byte-identical to `ariaSnapshot()` and carries no refs at all. So refs have to
 * come from us. This walks the DOM once, stamps `data-omni-ref` on every visible
 * interactive element and emits an accessibility-style outline referencing them.
 *
 * Runs inside the page, so it must be self-contained - no closure variables.
 */
function domSnapshot(maxNodes) {
  const out = [];
  let n = 0;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  };
  const labelFor = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const t = labelledBy.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean)
        .map((e) => e.textContent.trim()).join(" ");
      if (t) return t;
    }
    if (el.id) {
      const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lab && lab.textContent.trim()) return lab.textContent.trim();
    }
    const closest = el.closest("label");
    if (closest && closest.textContent.trim()) return closest.textContent.trim();
    const ph = el.getAttribute("placeholder");
    if (ph) return ph.trim();
    if (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA") {
      const nm = el.getAttribute("name");
      if (nm) return nm.trim();
    }
    return (el.textContent || "").trim();
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const t = el.tagName;
    if (t === "A") return el.hasAttribute("href") ? "link" : null;
    if (t === "BUTTON" || t === "SUMMARY") return "button";
    if (t === "SELECT") return "combobox";
    if (t === "TEXTAREA") return "textbox";
    if (t === "INPUT") {
      const ty = (el.getAttribute("type") || "text").toLowerCase();
      if (ty === "hidden") return null;
      if (ty === "checkbox") return "checkbox";
      if (ty === "radio") return "radio";
      if (ty === "submit" || ty === "button" || ty === "image" || ty === "reset") return "button";
      if (ty === "file") return "file-input";
      return "textbox";
    }
    if (/^H[1-6]$/.test(t)) return "heading";
    return null;
  };
  const walk = (el, depth) => {
    if (n >= maxNodes) return;
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "SVG" || tag === "HEAD") return;
    const pad = "  ".repeat(depth < 8 ? depth : 8);
    const role = roleOf(el);
    if (role && visible(el)) {
      n++;
      const ref = "e" + n;
      el.setAttribute("data-omni-ref", ref);
      const text = labelFor(el).replace(/\s+/g, " ").slice(0, 100);
      const extra = [];
      if (tag === "INPUT" || tag === "TEXTAREA") {
        if (el.value) extra.push('value="' + String(el.value).slice(0, 40) + '"');
        if (el.checked) extra.push("checked");
        if (el.required) extra.push("required");
        const ty = (el.getAttribute("type") || "text").toLowerCase();
        if (ty && ty !== "text") extra.push("type=" + ty);
      }
      if (tag === "SELECT") {
        const opts = Array.from(el.options).slice(0, 15).map((o) => o.textContent.trim()).filter(Boolean);
        if (opts.length) extra.push("options=[" + opts.join(" | ") + "]");
      }
      if (tag === "A" && el.href) extra.push("href=" + String(el.href).slice(0, 140));
      if (el.disabled) extra.push("disabled");
      if (/^H[1-6]$/.test(tag)) extra.push("level=" + tag[1]);
      out.push(pad + "- " + role + ' "' + text + '" [ref=' + ref + "]" + (extra.length ? " " + extra.join(" ") : ""));
    } else if (visible(el)) {
      let direct = "";
      for (const c of el.childNodes) if (c.nodeType === 3) direct += " " + c.textContent;
      direct = direct.replace(/\s+/g, " ").trim();
      if (direct.length > 1 && n < maxNodes) out.push(pad + "text: " + direct.slice(0, 220));
    }
    for (const child of el.children) walk(child, depth + 1);
  };
  if (document.body) walk(document.body, 0);
  return out.join("\n");
}

/**
 * Numbered outline of the current page.
 * @returns {Promise<{url:string,title:string,snapshot:string}>}
 */
export async function snapshot({ maxNodes = 600 } = {}) {
  const page = await activePage();
  const text = await page.evaluate(domSnapshot, maxNodes);
  return {
    url: page.url(),
    title: await page.title().catch(() => ""),
    tabs: _pages.length,
    activeTab: _active,
    refCount: (String(text).match(/\[ref=e\d+\]/g) || []).length,
    snapshot: String(text).slice(0, 60000),
  };
}

/** Resolve a ref stamped by domSnapshot to a Playwright locator. */
async function locate(page, ref) {
  if (!ref) throw new Error("a ref is required; call browser_snapshot first");
  const clean = String(ref).trim();
  const loc = page.locator('[data-omni-ref="' + clean + '"]');
  if ((await loc.count()) > 0) return loc.first();
  throw new Error("ref " + clean + " is not on the current page; take a fresh browser_snapshot");
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

export async function navigate(url, { waitUntil = "domcontentloaded", timeoutMs } = {}) {
  const page = await activePage();
  const cfg = loadConfig();
  const res = await page.goto(url, { waitUntil, timeout: timeoutMs ?? cfg.browser.timeoutMs });
  // Best-effort settle for SPA content; never fatal.
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  return { url: page.url(), status: res?.status() ?? null, title: await page.title().catch(() => "") };
}

export async function goBack() {
  const page = await activePage();
  await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
  return { url: page.url(), title: await page.title().catch(() => "") };
}

export async function goForward() {
  const page = await activePage();
  await page.goForward({ waitUntil: "domcontentloaded" }).catch(() => {});
  return { url: page.url(), title: await page.title().catch(() => "") };
}

export async function newTab(url) {
  await launch();
  const page = await _context.newPage();
  if (!_pages.includes(page)) _pages.push(page);
  _active = _pages.indexOf(page);
  if (url) await page.goto(url, { waitUntil: "domcontentloaded" });
  return { tabs: _pages.length, activeTab: _active, url: page.url() };
}

export async function selectTab(index) {
  await activePage();
  if (index < 0 || index >= _pages.length) throw new Error(`no tab ${index}; open tabs: ${_pages.length}`);
  _active = index;
  await _pages[index].bringToFront().catch(() => {});
  return { activeTab: _active, url: _pages[index].url(), title: await _pages[index].title().catch(() => "") };
}

export async function closeTab(index) {
  const i = index ?? _active;
  if (i < 0 || i >= _pages.length) throw new Error(`no tab ${i}`);
  await _pages[i].close().catch(() => {});
  _pages.splice(i, 1);
  _active = Math.max(0, Math.min(_active, _pages.length - 1));
  return { tabs: _pages.length, activeTab: _active };
}

export async function listTabs() {
  await activePage();
  const tabs = [];
  for (let i = 0; i < _pages.length; i++) {
    tabs.push({ index: i, active: i === _active, url: _pages[i].url(), title: await _pages[i].title().catch(() => "") });
  }
  return { tabs };
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

/** Controls whose activation is likely to have an external side effect. */
const SUBMIT_WORDS =
  /\b(submit|send|apply now|place order|buy|pay|purchase|checkout|confirm|delete|publish|post comment|sign up|register|subscribe|book now|donate)\b/i;

async function looksLikeSubmit(loc) {
  try {
    const info = await loc.evaluate((el) => ({
      tag: el.tagName,
      type: (el.getAttribute("type") || "").toLowerCase(),
      text: (el.innerText || el.value || el.getAttribute("aria-label") || "").slice(0, 120),
      inForm: !!el.closest("form"),
    }));
    if (info.type === "submit" && info.inForm) return info;
    if (SUBMIT_WORDS.test(info.text)) return info;
    return null;
  } catch {
    return null;
  }
}

export async function click(ref, { confirmSubmit = false, button = "left", clickCount = 1 } = {}) {
  const page = await activePage();
  const loc = await locate(page, ref);
  const submitish = await looksLikeSubmit(loc);
  if (submitish && !confirmSubmit) {
    return {
      blocked: true,
      reason: "submit-confirmation-required",
      control: submitish,
      message:
        "This control looks like it submits or commits something with an external effect. " +
        "Ask the user to confirm, then retry with confirmSubmit: true.",
    };
  }
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await loc.click({ button, clickCount });
  await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
  return { clicked: ref, submitted: !!submitish, url: page.url(), title: await page.title().catch(() => "") };
}

export async function type(ref, text, { clear = true, pressEnter = false } = {}) {
  const page = await activePage();
  const loc = await locate(page, ref);
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  if (clear) await loc.fill("").catch(() => {});
  await loc.fill(String(text));
  if (pressEnter) {
    await loc.press("Enter");
    await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
  }
  return { ref, typed: String(text).length + " chars", url: page.url() };
}

export async function selectOption(ref, values) {
  const page = await activePage();
  const loc = await locate(page, ref);
  const chosen = await loc.selectOption(Array.isArray(values) ? values : [String(values)]);
  return { ref, selected: chosen };
}

export async function setChecked(ref, checked = true) {
  const page = await activePage();
  const loc = await locate(page, ref);
  await loc.setChecked(!!checked);
  return { ref, checked: !!checked };
}

export async function hover(ref) {
  const page = await activePage();
  const loc = await locate(page, ref);
  await loc.hover();
  return { ref, hovered: true };
}

export async function pressKey(key) {
  const page = await activePage();
  await page.keyboard.press(key);
  return { key, url: page.url() };
}

export async function scroll({ direction = "down", amount = 600, ref } = {}) {
  const page = await activePage();
  if (ref) {
    const loc = await locate(page, ref);
    await loc.scrollIntoViewIfNeeded();
    return { scrolledTo: ref };
  }
  const dy = direction === "up" ? -amount : direction === "down" ? amount : 0;
  const dx = direction === "left" ? -amount : direction === "right" ? amount : 0;
  await page.mouse.wheel(dx, dy);
  return { direction, amount };
}

export async function uploadFile(ref, filePaths) {
  const page = await activePage();
  const loc = await locate(page, ref);
  const files = (Array.isArray(filePaths) ? filePaths : [filePaths]).map((p) => path.resolve(p));
  for (const f of files) if (!fs.existsSync(f)) throw new Error(`file not found: ${f}`);
  await loc.setInputFiles(files);
  return { ref, uploaded: files };
}

export async function waitFor({ ref, text, urlPattern, timeoutMs = 15000 } = {}) {
  const page = await activePage();
  if (ref) {
    const loc = await locate(page, ref);
    await loc.waitFor({ state: "visible", timeout: timeoutMs });
    return { waited: "ref", ref };
  }
  if (text) {
    await page.getByText(text, { exact: false }).first().waitFor({ state: "visible", timeout: timeoutMs });
    return { waited: "text", text };
  }
  if (urlPattern) {
    await page.waitForURL(new RegExp(urlPattern), { timeout: timeoutMs });
    return { waited: "url", url: page.url() };
  }
  await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => {});
  return { waited: "networkidle", url: page.url() };
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export async function extract({ format = "text", ref, maxChars = 40000 } = {}) {
  const page = await activePage();
  if (format === "html") {
    const html = ref ? await (await locate(page, ref)).innerHTML() : await page.content();
    return { url: page.url(), format, content: html.slice(0, maxChars) };
  }
  if (format === "markdown") {
    const html = await page.content();
    const { htmlToArticle } = await import("./web.mjs");
    const article = await htmlToArticle(html, page.url());
    return { url: page.url(), format, title: article.title, content: article.markdown.slice(0, maxChars) };
  }
  const text = ref ? await (await locate(page, ref)).innerText() : await page.evaluate(() => document.body.innerText);
  return { url: page.url(), format: "text", content: String(text).slice(0, maxChars) };
}

export async function screenshot({ fullPage = false, ref } = {}) {
  const page = await activePage();
  ensureDirs();
  const file = path.join(PATHS.downloads, `screenshot-${Date.now()}.png`);
  if (ref) {
    const loc = await locate(page, ref);
    await loc.screenshot({ path: file });
  } else {
    await page.screenshot({ path: file, fullPage });
  }
  return { path: file, url: page.url() };
}

/** Click a control and capture whatever file it triggers. */
export async function downloadVia(ref, { timeoutMs = 60000 } = {}) {
  const page = await activePage();
  ensureDirs();
  const loc = await locate(page, ref);
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: timeoutMs }),
    loc.click(),
  ]);
  const suggested = download.suggestedFilename() || `download-${Date.now()}`;
  const dest = path.join(PATHS.downloads, suggested);
  await download.saveAs(dest);
  return { path: dest, filename: suggested, url: page.url() };
}

/**
 * One-shot render used by the scraper.
 *
 * If no browser was already running, this one is closed again afterwards. A
 * Playwright browser holds open handles, so leaving one behind means a
 * short-lived process (a CLI command, a test run) never exits - which is
 * exactly what happened before this: `npm run test:integration` completed every
 * assertion and then hung forever.
 *
 * When a browser IS already open the agent is mid-task in it, so it is left
 * alone; only the temporary tab is closed.
 */
export async function renderPage(url, { timeoutMs = 45000 } = {}) {
  const wasRunning = !!(_browser && _browser.isConnected());
  await launch();
  const page = await _context.newPage();
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    return {
      finalUrl: page.url(),
      status: res?.status() ?? null,
      title: await page.title().catch(() => ""),
      html: await page.content(),
    };
  } finally {
    await page.close().catch(() => {});
    if (!wasRunning) await close();
  }
}
