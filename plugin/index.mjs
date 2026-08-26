// The Omni Agent tool layer, exposed to OpenCode.
//
// TOOL COUNT IS A BUDGET, NOT A FEATURE LIST. OpenCode's own docs warn that
// every tool description is spent from the model's context on every single
// turn, and that a sprawling tool surface makes models worse at choosing. So
// the whole browser - 18 distinct operations - is ONE tool with an `action`
// argument, rather than 18 tools. Eight tools total.
//
// Every tool returns a compact, structured string. Nothing dumps raw HTML into
// the transcript; large payloads are truncated with an explicit marker so the
// model knows it is looking at a prefix rather than the whole thing.
import { tool } from "@opencode-ai/plugin";

import { webSearch, availableProviders } from "../src/tools/search.mjs";
import { webFetch, scrapeUrl, crawlSite } from "../src/tools/web.mjs";
import * as browser from "../src/tools/browser-proxy.mjs";
import { readDocument, writeDocument, analyzeData } from "../src/tools/documents.mjs";
import { buildDashboard, renderDashboard } from "../src/usage/dashboard.mjs";
import { selectModel, PRESETS } from "../src/routing/select.mjs";
import { getCatalogue } from "../src/routing/catalog.mjs";
import { loadConfig, updateConfig } from "../src/config.mjs";
import { logger } from "../src/util/log.mjs";

const z = tool.schema;
const log = logger("plugin");

const j = (v) => JSON.stringify(v, null, 2);

function clip(text, max, label = "content") {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n[...truncated: ${s.length - max} more characters of ${label}. Narrow the request if you need the rest.]`;
}

export const OmniAgentPlugin = async () => {
  log.info("omni-agent plugin loaded");

  return {
    tool: {
      // ---------------------------------------------------------------------
      web_search: tool({
        description:
          "Search the open web and return ranked results. Returns SEARCH SNIPPETS, which are not verified page content - " +
          "fetch a result with web_fetch before asserting anything specific from it. Falls back across configured " +
          "providers automatically and works with no API key.",
        args: {
          query: z.string().describe("The search query."),
          count: z.number().int().min(1).max(25).optional().describe("How many results (default 10)."),
        },
        async execute(args) {
          const r = await webSearch(args.query, { count: args.count ?? 10 });
          const lines = r.results.map(
            (x, i) => `${i + 1}. ${x.title}\n   URL: ${x.url}\n   Snippet: ${clip(x.snippet, 300, "snippet")}`
          );
          return {
            title: `web_search: ${args.query}`,
            output:
              `Provider: ${r.provider}\nResults: ${r.results.length} (these are SNIPPETS, not verified page content)\n\n` +
              lines.join("\n\n"),
            metadata: { provider: r.provider, count: r.results.length },
          };
        },
      }),

      // ---------------------------------------------------------------------
      web_fetch: tool({
        description:
          "Fetch one URL and return its readable content as markdown. This is VERIFIED page content, unlike a search " +
          "snippet. Use it before citing any specific claim, deadline, figure or eligibility rule. Reports the final " +
          "URL after redirects - always cite that one, not the URL you asked for.",
        args: {
          url: z.string().describe("Absolute http(s) URL."),
          format: z.enum(["markdown", "text", "html"]).optional().describe("Default markdown."),
          render: z.boolean().optional().describe("Force a real browser render. Use only when a plain fetch came back empty."),
          maxChars: z.number().int().min(500).max(200000).optional(),
        },
        async execute(args) {
          const r = await webFetch(args.url, {
            format: args.format ?? "markdown",
            render: args.render ?? false,
            maxChars: args.maxChars ?? 40000,
          });
          if (!r.ok) {
            return { title: `web_fetch failed: ${args.url}`, output: `Could not fetch.\nStatus: ${r.status ?? "?"}\nError: ${r.error}` };
          }
          if (r.kind === "binary") {
            return {
              title: `web_fetch: binary at ${r.finalUrl}`,
              output: `This URL returned ${r.contentType} (${r.bytes} bytes), not a web page.\nDownload it first, then use document_read.`,
            };
          }
          const header =
            `Final URL (cite this): ${r.finalUrl}\nStatus: ${r.status}\n` +
            (r.title ? `Title: ${r.title}\n` : "") +
            (r.thin ? "NOTE: very little text was extracted. Consider render:true.\n" : "");
          return {
            title: `web_fetch: ${r.title ?? r.finalUrl}`,
            output: header + "\n" + clip(r.content, args.maxChars ?? 40000, "page content"),
            metadata: { finalUrl: r.finalUrl, status: r.status, thin: !!r.thin },
          };
        },
      }),

      // ---------------------------------------------------------------------
      web_scrape: tool({
        description:
          "Bulk web extraction. mode='page' scrapes one URL, escalating from plain HTTP to a real browser render when " +
          "the page needs JavaScript. mode='crawl' walks a site breadth-first within one host. Prefer web_fetch for a " +
          "single ordinary page; use this when that came back empty, or when you need many pages from one site.",
        args: {
          mode: z.enum(["page", "crawl"]).describe("'page' for one URL, 'crawl' for a site."),
          url: z.string().describe("Start URL."),
          maxPages: z.number().int().min(1).max(100).optional().describe("crawl only. Default 25."),
          includePattern: z.string().optional().describe("crawl only. Regex a URL must match to be visited."),
          sameHostOnly: z.boolean().optional().describe("crawl only. Default true."),
        },
        async execute(args) {
          if (args.mode === "crawl") {
            const r = await crawlSite(args.url, {
              maxPages: args.maxPages ?? 25,
              includePattern: args.includePattern,
              sameHostOnly: args.sameHostOnly ?? true,
            });
            const body = r.pages
              .map((p, i) => `--- [${i + 1}] ${p.title ?? "(untitled)"}\nURL: ${p.url}\n${clip(p.content, 2500, "page")}`)
              .join("\n\n");
            return {
              title: `web_scrape crawl: ${r.pageCount} pages`,
              output:
                `Crawled ${r.pageCount} pages from ${r.startUrl} (discovered ${r.discovered} links, stopped: ${r.stoppedBecause}).\n` +
                (r.errors.length ? `${r.errors.length} pages failed.\n` : "") +
                "\n" + clip(body, 60000, "crawl output"),
              metadata: { pageCount: r.pageCount, errors: r.errors.length },
            };
          }
          const r = await scrapeUrl(args.url, {});
          if (!r.ok) {
            return {
              title: `web_scrape failed: ${args.url}`,
              output: `All strategies failed.\n${r.attempted.map((a) => `  ${a.provider}: ${a.error}`).join("\n")}`,
            };
          }
          return {
            title: `web_scrape: ${r.title ?? r.finalUrl}`,
            output:
              `Strategy used: ${r.provider}\nFinal URL (cite this): ${r.finalUrl}\n` +
              (r.attempted?.length ? `Escalated past: ${r.attempted.map((a) => a.provider).join(", ")}\n` : "") +
              "\n" + clip(r.content, 40000, "page content"),
            metadata: { provider: r.provider, finalUrl: r.finalUrl },
          };
        },
      }),

      // ---------------------------------------------------------------------
      browser: tool({
        description:
          "Drive a real Chromium browser for interactive work: logging in, filling forms, clicking through JavaScript " +
          "apps, downloading files. The browser and its tabs persist between calls, so a task can span many steps.\n\n" +
          "ALWAYS call action='snapshot' first. It returns a numbered outline where every interactive element has a " +
          "[ref=eN] marker, and every other action targets an element by that ref. Refs change whenever the page " +
          "changes, so re-snapshot after anything that navigates or updates the DOM.\n\n" +
          "Clicking a control that submits or commits something is refused unless confirmSubmit is true, which you may " +
          "only set after the user has explicitly authorised that specific submission in the conversation.",
        args: {
          action: z
            .enum([
              "navigate", "snapshot", "click", "type", "select", "check", "uncheck", "hover",
              "key", "scroll", "upload", "extract", "screenshot", "download",
              "wait", "back", "forward", "new_tab", "select_tab", "close_tab", "list_tabs", "close",
            ])
            .describe("What to do."),
          url: z.string().optional().describe("navigate / new_tab."),
          ref: z.string().optional().describe("Element ref from a snapshot, e.g. 'e12'."),
          text: z.string().optional().describe("type: the text to enter. wait: text to wait for."),
          value: z.string().optional().describe("select: option value or visible label."),
          key: z.string().optional().describe("key: e.g. 'Enter', 'Escape', 'Control+A'."),
          files: z.array(z.string()).optional().describe("upload: absolute local file paths."),
          format: z.enum(["text", "markdown", "html"]).optional().describe("extract format. Default text."),
          direction: z.enum(["up", "down", "left", "right"]).optional(),
          index: z.number().int().optional().describe("select_tab / close_tab."),
          pressEnter: z.boolean().optional().describe("type: submit the field with Enter afterwards."),
          fullPage: z.boolean().optional().describe("screenshot."),
          confirmSubmit: z
            .boolean()
            .optional()
            .describe("Only set true when the user has explicitly authorised this specific submission."),
        },
        async execute(args, ctx) {
          const a = args.action;
          try {
            switch (a) {
              case "navigate":
                if (!args.url) throw new Error("navigate needs a url");
                return { title: `browser: ${args.url}`, output: j(await browser.navigate(args.url)) };
              case "snapshot": {
                const s = await browser.snapshot();
                return {
                  title: `browser snapshot: ${s.title || s.url}`,
                  output:
                    `URL: ${s.url}\nTitle: ${s.title}\nTabs open: ${s.tabs} (active ${s.activeTab})\n` +
                    `Interactive elements: ${s.refCount}\n\n${clip(s.snapshot, 30000, "page outline")}`,
                  metadata: { url: s.url, refCount: s.refCount },
                };
              }
              case "click": {
                // OpenCode's own permission prompt, so the user sees and approves
                // the submission in the UI rather than it being decided in-model.
                if (args.confirmSubmit && typeof ctx?.ask === "function") {
                  await ctx.ask({
                    permission: "browser_submit",
                    patterns: [args.ref ?? "*"],
                    always: [],
                    metadata: { action: "submit", ref: args.ref },
                  });
                }
                const r = await browser.click(args.ref, { confirmSubmit: !!args.confirmSubmit });
                if (r.blocked) {
                  return {
                    title: "browser: submission blocked",
                    output:
                      `BLOCKED - this control looks like it commits something with an external effect.\n` +
                      `Control: ${r.control.tag} "${r.control.text}"\n\n` +
                      `Ask the user to confirm this specific submission, then call again with confirmSubmit: true.`,
                  };
                }
                return { title: `browser click ${args.ref}`, output: j(r) };
              }
              case "type":
                return {
                  title: `browser type into ${args.ref}`,
                  output: j(await browser.type(args.ref, args.text ?? "", { pressEnter: !!args.pressEnter })),
                };
              case "select":
                return { title: `browser select ${args.ref}`, output: j(await browser.selectOption(args.ref, args.value)) };
              case "check":
                return { title: `browser check ${args.ref}`, output: j(await browser.setChecked(args.ref, true)) };
              case "uncheck":
                return { title: `browser uncheck ${args.ref}`, output: j(await browser.setChecked(args.ref, false)) };
              case "hover":
                return { title: `browser hover ${args.ref}`, output: j(await browser.hover(args.ref)) };
              case "key":
                return { title: `browser key ${args.key}`, output: j(await browser.pressKey(args.key)) };
              case "scroll":
                return { title: "browser scroll", output: j(await browser.scroll({ direction: args.direction, ref: args.ref })) };
              case "upload":
                return { title: `browser upload to ${args.ref}`, output: j(await browser.uploadFile(args.ref, args.files ?? [])) };
              case "extract": {
                const r = await browser.extract({ format: args.format ?? "text", ref: args.ref });
                return {
                  title: `browser extract (${r.format})`,
                  output: `URL: ${r.url}\n\n${clip(r.content, 40000, "page content")}`,
                };
              }
              case "screenshot": {
                const r = await browser.screenshot({ fullPage: !!args.fullPage, ref: args.ref });
                return { title: "browser screenshot", output: `Saved to ${r.path}\nPage: ${r.url}` };
              }
              case "download": {
                const r = await browser.downloadVia(args.ref);
                return { title: `browser download`, output: `Saved ${r.filename} to ${r.path}` };
              }
              case "wait":
                return { title: "browser wait", output: j(await browser.waitFor({ ref: args.ref, text: args.text })) };
              case "back":
                return { title: "browser back", output: j(await browser.goBack()) };
              case "forward":
                return { title: "browser forward", output: j(await browser.goForward()) };
              case "new_tab":
                return { title: "browser new tab", output: j(await browser.newTab(args.url)) };
              case "select_tab":
                return { title: `browser tab ${args.index}`, output: j(await browser.selectTab(args.index ?? 0)) };
              case "close_tab":
                return { title: "browser close tab", output: j(await browser.closeTab(args.index)) };
              case "list_tabs":
                return { title: "browser tabs", output: j(await browser.listTabs()) };
              case "close":
                return { title: "browser closed", output: j(await browser.close()) };
              default:
                throw new Error(`unknown action: ${a}`);
            }
          } catch (err) {
            return {
              title: `browser ${a} failed`,
              output: `Error: ${err.message}\n\nIf this mentions a ref, take a fresh action='snapshot' - refs are invalidated whenever the page changes.`,
            };
          }
        },
      }),

      // ---------------------------------------------------------------------
      document_read: tool({
        description:
          "Read a local document and return its text or records. Handles PDF, DOCX, XLSX, CSV, TSV, JSON, TXT and " +
          "Markdown. For a spreadsheet or CSV you usually want data_analyze instead - it gives statistics without " +
          "pouring every row into the conversation.",
        args: {
          path: z.string().describe("Absolute or workspace-relative path."),
          maxChars: z.number().int().min(500).max(400000).optional(),
          maxPages: z.number().int().min(1).max(500).optional().describe("PDF only."),
        },
        async execute(args) {
          const d = await readDocument(args.path, { maxChars: args.maxChars ?? 60000, maxPages: args.maxPages });
          let body;
          if (d.kind === "csv") {
            body = `Rows: ${d.rowCount}\nColumns: ${d.headers.join(", ")}\n\nFirst 20 rows:\n` + j(d.records.slice(0, 20));
          } else if (d.kind === "xlsx") {
            body = d.sheets
              .map((s) => `Sheet "${s.name}": ${s.rowCount} rows\nColumns: ${s.headers.join(", ")}\nFirst 10 rows:\n${j(s.records.slice(0, 10))}`)
              .join("\n\n");
          } else if (d.kind === "json") {
            body = clip(d.text, args.maxChars ?? 60000, "JSON");
          } else {
            body = clip(d.text, args.maxChars ?? 60000, d.kind);
          }
          return {
            title: `document_read: ${d.filename}`,
            output: `File: ${d.path}\nType: ${d.kind}${d.pageCount ? ` (${d.pageCount} pages, read ${d.pagesRead})` : ""}\n${d.truncated ? `TRUNCATED from ${d.originalChars} characters.\n` : ""}\n${body}`,
            metadata: { kind: d.kind, path: d.path },
          };
        },
      }),

      // ---------------------------------------------------------------------
      document_write: tool({
        description:
          "Write a result file. Extension picks the format: .csv, .xlsx, .json, .md, .txt. For .csv and .xlsx pass an " +
          "array of objects (keys become the header row) or an array of arrays. For .xlsx you may pass an object of " +
          "{sheetName: rows} to write several sheets.",
        args: {
          path: z.string().describe("Destination path, including extension."),
          content: z.string().describe("Text content, or JSON for structured formats."),
          json: z.boolean().optional().describe("Set true when `content` is JSON that should be parsed first."),
        },
        async execute(args) {
          let payload = args.content;
          if (args.json || /\.(csv|xlsx|json)$/i.test(args.path)) {
            try {
              payload = JSON.parse(args.content);
            } catch (err) {
              if (/\.(csv|xlsx)$/i.test(args.path)) {
                return { title: "document_write failed", output: `This format needs JSON in \`content\`, but it did not parse: ${err.message}` };
              }
            }
          }
          const r = await writeDocument(args.path, payload);
          return { title: `document_write: ${r.path}`, output: j(r), metadata: r };
        },
      }),

      // ---------------------------------------------------------------------
      data_analyze: tool({
        description:
          "Summary statistics for a CSV, TSV, XLSX or JSON-array file: row and column counts, per-column type, missing " +
          "values, distinct counts, min/max/mean/median/stdev for numeric columns and top values for text columns. " +
          "Computed locally and deterministically - it costs no model tokens, so prefer it over reading a whole table.",
        args: {
          path: z.string(),
          sheet: z.string().optional().describe("XLSX only. Defaults to the first sheet."),
        },
        async execute(args) {
          const r = await analyzeData(args.path, { sheet: args.sheet });
          const cols = r.columns
            .map((c) => {
              const base = `  ${c.name}: ${c.type}, ${c.nonEmpty}/${c.count} populated, ${c.distinct} distinct`;
              return c.type === "numeric"
                ? `${base}\n    min ${c.min}  max ${c.max}  mean ${c.mean}  median ${c.median}  stdev ${c.stdev}  sum ${c.sum}`
                : `${base}\n    top: ${(c.top ?? []).map((t) => `${t.value} (${t.n})`).join(", ")}`;
            })
            .join("\n");
          return {
            title: `data_analyze: ${r.rowCount} rows`,
            output: `File: ${r.path}\nSource: ${r.source}\nRows: ${r.rowCount}  Columns: ${r.columnCount}\n\nColumns:\n${cols}\n\nSample rows:\n${j(r.sample)}`,
            metadata: { rowCount: r.rowCount, columnCount: r.columnCount },
          };
        },
      }),

      // ---------------------------------------------------------------------
      agent_status: tool({
        description:
          "Report or change how this agent is configured: which model is in use, the routing mode, live provider " +
          "quota/balance, and token usage measured on this machine. Use it when the user asks what model they are on, " +
          "what something is costing, how much quota is left, or asks to switch to a faster/cheaper/stronger model.",
        args: {
          action: z.enum(["status", "models", "set_mode", "pin_model", "unpin_model"]).describe("Default 'status'."),
          mode: z.enum(["fast", "balanced", "smart", "quality", "cheap"]).optional(),
          model: z.string().optional().describe("pin_model: exact model id from action='models'."),
        },
        async execute(args) {
          const action = args.action ?? "status";

          if (action === "set_mode") {
            if (!args.mode) throw new Error("set_mode needs a mode");
            updateConfig({ routing: { ...loadConfig().routing, mode: args.mode } });
            const p = PRESETS[args.mode];
            return { title: `routing mode: ${args.mode}`, output: `Routing mode is now "${p.label}".\n${p.description}` };
          }
          if (action === "pin_model") {
            if (!args.model) throw new Error("pin_model needs a model id");
            const cat = await getCatalogue();
            if (!cat.some((m) => m.id === args.model)) {
              return { title: "pin_model failed", output: `"${args.model}" is not in the gateway catalogue. Run action='models' to see valid ids.` };
            }
            updateConfig({ routing: { ...loadConfig().routing, pinnedModel: args.model } });
            return { title: `pinned ${args.model}`, output: `All requests now use ${args.model} until unpinned.` };
          }
          if (action === "unpin_model") {
            updateConfig({ routing: { ...loadConfig().routing, pinnedModel: null } });
            return { title: "model unpinned", output: "Automatic routing restored." };
          }
          if (action === "models") {
            const cat = await getCatalogue();
            const combos = cat.filter((m) => m.isCombo);
            const models = cat.filter((m) => !m.isCombo);
            const fmt = (m) =>
              `  ${m.id.padEnd(34)} ${String(m.capabilityTier ?? "unrated").padEnd(12)} ${String(m.speedTier ?? "?").padEnd(10)}` +
              `${m.contextLength ? ` ctx ${m.contextLength}` : ""}${m.capabilities.toolCalling ? " tools" : ""}${m.capabilities.vision ? " vision" : ""}` +
              `${m.observed?.outputTokensPerSec != null ? `  ${m.observed.outputTokensPerSec} tok/s measured` : ""}`;
            return {
              title: `${cat.length} models available`,
              output:
                "Capability and speed tiers below are LOCAL ESTIMATES maintained in this product, not benchmark scores.\n" +
                "Throughput is shown only where this machine has actually measured it.\n\n" +
                `AUTOMATIC ROUTING (recommended - the gateway picks and falls back):\n${combos.map(fmt).join("\n")}\n\n` +
                `SPECIFIC MODELS (${models.length}):\n${models.slice(0, 60).map(fmt).join("\n")}`,
              metadata: { total: cat.length },
            };
          }

          const d = await buildDashboard();
          const cfg = loadConfig();
          let chosen = null;
          try {
            const sel = await selectModel({ task: "code", needsTools: true });
            chosen = `${sel.model}  (${sel.via}: ${sel.reason})`;
          } catch (err) {
            chosen = `could not resolve: ${err.message}`;
          }
          return {
            title: "agent status",
            output: `Model that a coding request would use right now:\n  ${chosen}\n\n${renderDashboard(d)}`,
            metadata: { mode: cfg.routing.mode },
          };
        },
      }),
    },
  };
};

export default OmniAgentPlugin;
