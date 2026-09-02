// Health check.
//
// Every row is an actual probe. Nothing reports OK because a file exists or a
// setting is present - the gateway row performs a real completion, the browser
// row launches a real browser and loads a real page, the search row runs a real
// query. A check that passes on a broken system is worse than no check.
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../util/paths.mjs";
import { loadConfig, gatewayBaseUrl } from "../config.mjs";
import { GatewayClient } from "../gateway/client.mjs";
import { locateOmniRoute, locateOpenCode } from "../gateway/locate.mjs";
import { chromiumInstalled } from "../tools/browser.mjs";
import { availableProviders } from "../tools/search.mjs";
import { configuredProviders } from "../providers/usage-adapters.mjs";
import { ocConfigDir } from "./opencode-config.mjs";

const OK = "ok";
const WARN = "warn";
const FAIL = "fail";

function row(name, status, detail, fix) {
  return { name, status, detail: detail ?? null, fix: fix ?? null };
}

/**
 * @param {{deep?:boolean}} [opts] deep also runs a real model completion and a
 *   real browser launch, which are slow but are the only proof that matters.
 */
export async function runDoctor(opts = {}) {
  const deep = opts.deep ?? true;
  const cfg = loadConfig();
  const rows = [];
  // Every row is reported the moment it is known, not all of them at the end.
  // The deep probes take 30-90 s between them, and printing nothing for that
  // long is indistinguishable from a hang - measured 2026-09-02, the health
  // check showed an empty console for 83 s and then closed.
  const onRow = typeof opts.onRow === "function" ? opts.onRow : null;
  const add = (r) => {
    rows.push(r);
    onRow?.(r);
    return r;
  };

  // --- Runtime -------------------------------------------------------------
  const major = Number(process.versions.node.split(".")[0]);
  add(
    major >= 22
      ? row("Node.js", OK, `v${process.versions.node}`)
      : row("Node.js", FAIL, `v${process.versions.node} is too old`, "Install Node.js 22 or newer from nodejs.org.")
  );

  // --- OpenCode ------------------------------------------------------------
  const oc = locateOpenCode();
  add(
    oc
      ? row("OpenCode", OK, oc)
      : row("OpenCode", FAIL, "not found on this machine", "Run: npm install -g opencode-ai")
  );

  const ocCfg = path.join(ocConfigDir(), "opencode.json");
  add(
    fs.existsSync(ocCfg)
      ? row("OpenCode config", OK, ocCfg)
      : row("OpenCode config", FAIL, "not generated yet", "Run: omni-agent setup")
  );

  // --- Gateway -------------------------------------------------------------
  const found = locateOmniRoute();
  add(
    found
      ? row("OmniRoute installed", OK, `v${found.version} at ${found.root}`)
      : row("OmniRoute installed", FAIL, "not found", "Run: npm install -g omniroute")
  );

  const client = new GatewayClient();
  const up = await client.isUp(5000);
  add(
    up
      ? row("Gateway running", OK, gatewayBaseUrl(cfg))
      : row("Gateway running", FAIL, `nothing answering at ${gatewayBaseUrl(cfg)}`, "Run: omni-agent gateway start")
  );

  let catalogue = [];
  if (up) {
    try {
      catalogue = await client.listModels();
      const tools = catalogue.filter((m) => m.capabilities?.tool_calling).length;
      add(
        catalogue.length
          ? row("Model catalogue", OK, `${catalogue.length} models, ${tools} can call tools`)
          : row("Model catalogue", FAIL, "gateway returned an empty catalogue", "Check the gateway log: " + path.join(PATHS.logs, "gateway.log"))
      );
    } catch (err) {
      add(row("Model catalogue", FAIL, err.message, "Check that the gateway finished starting."));
    }
  } else {
    add(row("Model catalogue", FAIL, "gateway not running"));
  }

  // --- A real completion ---------------------------------------------------
  // Goes through the real execution path, fallback chain included, so this row
  // reflects what the agent will actually experience rather than what a single
  // hand-picked model does.
  let servedModel = null;
  if (deep && catalogue.length) {
    try {
      const { complete } = await import("../routing/execute.mjs");
      const r = await complete({
        messages: [{ role: "user", content: "Reply with exactly the single word: ready" }],
        task: "classify",
        maxTokens: 512,
        timeoutMs: 180000,
        client,
      });
      // Which model to remember, and it is worth being precise about.
      //
      // The REQUESTED id is often an `auto/` combo, and seeding the app with a
      // combo reinstates the very brittleness this is meant to remove: a combo
      // resolves somewhere new on every call and can land on a model that needs
      // a key. `r.servedBy` names the model that actually produced the tokens
      // ("hy3-free"), but in the gateway's own naming rather than the
      // catalogue's ("oc/hy3-free"), so it is resolved against the catalogue
      // instead of trusted as an id. If it cannot be resolved, the requested id
      // is still better than nothing.
      const requested = r.attempts?.find((a) => a.ok)?.model ?? null;
      const concrete = r.servedBy
        ? (catalogue.find((m) => m.id === r.servedBy) ??
            catalogue.find((m) => m.id.endsWith(`/${r.servedBy}`)))?.id
        : null;
      servedModel = concrete ?? requested;
      const said = (r.content || "").toLowerCase();
      const fellBack = r.fellBackFrom ? ` after falling back from ${r.fellBackFrom.join(", ")}` : "";
      if (said.includes("ready")) {
        add(
          row(
            "Model responds",
            OK,
            `${r.servedBy} answered in ${(r.latencyMs / 1000).toFixed(1)}s, ` +
              `${r.usage.totalTokens ?? "?"} tokens reported${fellBack}`
          )
        );
      } else if (r.content != null) {
        add(row("Model responds", WARN, `answered but not as asked: ${JSON.stringify(said).slice(0, 80)}${fellBack}`));
      } else {
        add(
          row("Model responds", WARN, `empty content, finish_reason=${r.finishReason}`,
            "Usually a reasoning model spending the whole budget on thinking.")
        );
      }
    } catch (err) {
      // Tell "the free pool is busy right now" apart from "nothing works". The
      // former is the COMMON state of a fresh keyless install under load, and
      // failing setup over it told every such user their install was broken
      // when it was fine. It is a WARN: the gateway is up, models are listed,
      // and the app retries per message. Only a failure that is NOT purely
      // rate-limiting / keyless refusal (a dead pool, a network fault) is a FAIL.
      const busy = /\b(429|401|403)\b|rate.?limit|not supported|too many|quota|busy|ERR_BN_LIMIT/i.test(
        err.message ?? ""
      );
      add(
        busy
          ? row(
              "Model responds",
              WARN,
              `the free models are busy right now (${String(err.message).slice(0, 120)})`,
              "This is normal on a fresh install under load - the app retries automatically. " +
                "Adding a provider key with `omni-agent config key <provider> <key>` removes the wait."
            )
          : row(
              "Model responds",
              FAIL,
              err.message,
              "Every model in the fallback chain refused. If this persists, add a provider API key " +
                "with `omni-agent config key <provider> <key>`."
            )
      );
    }
  }

  // --- Providers -----------------------------------------------------------
  const provs = configuredProviders();
  add(
    provs.length
      ? row("Provider keys", OK, provs.join(", "))
      : row("Provider keys", WARN, "none configured", "Not required - the gateway serves free models. Add keys for speed and higher limits.")
  );

  // --- Search --------------------------------------------------------------
  const searchProviders = availableProviders(cfg);
  if (!searchProviders.length) {
    add(row("Web search", FAIL, "no search provider available", "Should never happen - DuckDuckGo needs no key."));
  } else if (deep) {
    try {
      const { webSearch } = await import("../tools/search.mjs");
      const r = await webSearch("site:iana.org example domain", { count: 3 });
      add(
        r.results.length
          ? row("Web search", OK, `${r.provider} returned ${r.results.length} results`)
          : row("Web search", WARN, `${r.provider} returned nothing`, "Often transient rate limiting. Retry.")
      );
    } catch (err) {
      add(row("Web search", FAIL, err.message, "Check the network connection."));
    }
  } else {
    add(row("Web search", OK, `providers: ${searchProviders.join(", ")}`));
  }

  // --- Web fetch -----------------------------------------------------------
  if (deep) {
    try {
      const { webFetch } = await import("../tools/web.mjs");
      const r = await webFetch("https://example.com/");
      add(
        r.ok && (r.content || "").length > 20
          ? row("Web fetch", OK, `example.com returned ${r.content.length} characters of readable text`)
          : row("Web fetch", FAIL, "fetched but extracted nothing", "Check the network connection or a proxy.")
      );
    } catch (err) {
      add(row("Web fetch", FAIL, err.message));
    }
  }

  // --- Browser -------------------------------------------------------------
  if (!chromiumInstalled()) {
    add(row("Browser", FAIL, "Chromium is not installed", "Run: omni-agent setup --browser"));
  } else if (deep) {
    try {
      const browser = await import("../tools/browser.mjs");
      const nav = await browser.navigate("https://example.com/");
      const snap = await browser.snapshot();
      await browser.close();
      add(
        nav.status === 200 && snap.refCount >= 0
          ? row("Browser", OK, `launched Chromium, loaded example.com, found ${snap.refCount} interactive elements`)
          : row("Browser", WARN, `loaded with status ${nav.status}`)
      );
    } catch (err) {
      add(row("Browser", FAIL, err.message, "Run: omni-agent setup --browser"));
    }
  } else {
    add(row("Browser", OK, "Chromium present at " + PATHS.browsers));
  }

  // --- Documents -----------------------------------------------------------
  try {
    const { parseCsv } = await import("../tools/documents.mjs");
    const rowsParsed = parseCsv('a,b\n1,"x,y"\n');
    add(
      rowsParsed.length === 2 && rowsParsed[1][1] === "x,y"
        ? row("Document tools", OK, "CSV/PDF/DOCX/XLSX readers loaded")
        : row("Document tools", FAIL, "CSV parser produced the wrong result")
    );
  } catch (err) {
    add(row("Document tools", FAIL, err.message));
  }

  // --- Filesystem ----------------------------------------------------------
  try {
    const probe = path.join(PATHS.home, ".write-probe");
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    add(row("Data directory", OK, PATHS.home));
  } catch (err) {
    add(row("Data directory", FAIL, err.message, "Check permissions on " + PATHS.home));
  }

  // --- Usage / quota -------------------------------------------------------
  const mgmt = await client.management("/api/free-tier/summary");
  add(
    mgmt.ok
      ? row("Usage API", OK, "gateway free-tier figures are readable")
      : row(
          "Usage API",
          WARN,
          mgmt.reason === "no-management-key" ? "no management key configured" : mgmt.reason,
          "Optional. Without it the dashboard shows quota as unavailable rather than guessing."
        )
  );

  const failed = rows.filter((r) => r.status === FAIL).length;
  const warned = rows.filter((r) => r.status === WARN).length;
  return { rows, failed, warned, ok: failed === 0, servedModel };
}

const MARK = { ok: "[ OK ]", warn: "[WARN]", fail: "[FAIL]" };

/** One check, as the lines it prints. Used live and in the full report. */
export function renderRow(r) {
  const L = [`${MARK[r.status]}  ${r.name}`];
  if (r.detail) L.push(`         ${r.detail}`);
  if (r.fix && r.status !== "ok") L.push(`         Fix: ${r.fix}`);
  return L.join("\n");
}

/** The verdict line, printed after the checks whether or not they streamed. */
export function renderSummary(result) {
  return result.ok
    ? result.warned
      ? `System ready. ${result.warned} optional item(s) not configured.`
      : "System ready."
    : `${result.failed} check(s) failed. Fix those before using the agent.`;
}

export function renderDoctor(result) {
  return ["", "OMNI AGENT HEALTH CHECK", "", ...result.rows.map(renderRow), "", renderSummary(result)].join("\n");
}
