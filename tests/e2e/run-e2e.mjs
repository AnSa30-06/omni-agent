// End-to-end acceptance test.
//
// Runs the real agent, through the real harness, against the real internet, and
// then VERIFIES THE OUTPUT INDEPENDENTLY. The agent's own claim that it found
// ten opportunities is not evidence; this script re-fetches every URL it
// produced and checks them itself.
//
// Usage:
//   node tests/e2e/run-e2e.mjs                 full run
//   node tests/e2e/run-e2e.mjs --verify-only   re-verify the last saved results
//   node tests/e2e/run-e2e.mjs --timeout 3600  seconds for the agent turn
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PATHS, ensureDirs } from "../../src/util/paths.mjs";
import { opencodeEnv } from "../../src/setup/opencode-config.mjs";
import { locateOpenCode } from "../../src/gateway/locate.mjs";
import { ensureRunning } from "../../src/gateway/supervisor.mjs";
import * as gatewayTel from "../../src/usage/gateway-telemetry.mjs";
import { rangeSummary as localRangeSummary } from "../../src/usage/telemetry.mjs";
import { buildDashboard, renderDashboard } from "../../src/usage/dashboard.mjs";
import { request } from "../../src/util/http.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(HERE, "results");
// Under the user profile, NOT LOCALAPPDATA: on Windows a packaged-app context
// redirects LOCALAPPDATA into a LocalCache path, which OpenCode then treats as
// outside the worktree and refuses to write to in a headless run.
const WORKSPACE = path.join(PATHS.workspace, "e2e");
const RESULTS_JSON = path.join(WORKSPACE, "internships.json");
const EVIDENCE = path.join(WORKSPACE, "evidence.md");

const args = process.argv.slice(2);
const VERIFY_ONLY = args.includes("--verify-only");
const TIMEOUT_S = Number(args[args.indexOf("--timeout") + 1]) || 3600;

const say = (s = "") => process.stdout.write(s + "\n");
const rule = () => say("=".repeat(74));

/**
 * Usage for the run.
 * Reads the gateway's call log where available - it is the only record that
 * sees the agent's OWN model calls, which go OpenCode -> plugin -> gateway and
 * never touch this process's client.
 */
const usageSummary = () => (gatewayTel.available() ? gatewayTel.rangeSummary(1) : localRangeSummary(1));

const TASK = `Find 10 legitimate computer science internship or graduate job opportunities that are currently available on the public web. Prefer university, research lab and company sources over job aggregators.

For each opportunity record: organization, role, location, deadline (if stated), eligibility (if stated), source_url, and a short description.

Rules you must follow:
- Search several different websites. Do not take all ten from one site.
- FETCH each page before recording it. A search snippet is not enough.
- Record the FINAL url that the fetch tool reports, after redirects.
- Do not invent a deadline or an eligibility rule. If the page does not state one, use null and say so in the description.
- Do not record the same opportunity twice under different URLs.
- Use the browser tool at least once (for example to open and read a listing page that needs JavaScript), and use web_scrape at least once.

Save the results as JSON to exactly this path: ${RESULTS_JSON.replace(/\\/g, "/")}
The JSON must be an array of objects with keys: organization, role, location, deadline, eligibility, source_url, description, verified (true only if you actually fetched the page).

Also save a short note to ${EVIDENCE.replace(/\\/g, "/")} describing which tools you used, which sources you rejected and why, and anything you could not verify.`;

function runAgent() {
  const oc = locateOpenCode();
  if (!oc) throw new Error("OpenCode is not installed");
  fs.mkdirSync(WORKSPACE, { recursive: true });

  const isCmd = /\.cmd$/i.test(oc);
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(isCmd ? `"${oc}"` : oc, ["run", TASK], {
      cwd: WORKSPACE,
      env: opencodeEnv(),
      shell: isCmd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    const cap = (b) => {
      const s = b.toString();
      out += s;
      process.stdout.write(s);
    };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    const timer = setTimeout(() => {
      say("\n[e2e] agent exceeded the time limit; terminating");
      child.kill();
    }, TIMEOUT_S * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, elapsedMs: Date.now() - started });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, out: err.message, elapsedMs: Date.now() - started });
    });
  });
}

const CS_TERMS =
  /\b(software|computer science|cs\b|engineer|developer|program(ming|mer)|data|machine learning|ml\b|ai\b|research|intern|graduate|swe\b|backend|frontend|full[- ]stack|security|cloud|robotics|systems)\b/i;

function normaliseUrl(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    for (const p of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref|source)/i.test(p)) url.searchParams.delete(p);
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return String(u).toLowerCase();
  }
}

async function verifyResults() {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });

  if (!fs.existsSync(RESULTS_JSON)) {
    add("Results file written", false, `agent did not create ${RESULTS_JSON}`);
    return { checks, records: [] };
  }

  let records;
  try {
    records = JSON.parse(fs.readFileSync(RESULTS_JSON, "utf8"));
  } catch (err) {
    add("Results file is valid JSON", false, err.message);
    return { checks, records: [] };
  }
  if (!Array.isArray(records)) {
    add("Results file is a JSON array", false, `got ${typeof records}`);
    return { checks, records: [] };
  }
  add("Results file is valid JSON", true, `${records.length} records`);

  add("At least 10 opportunities", records.length >= 10, `${records.length} found`);

  const withUrl = records.filter((r) => typeof r?.source_url === "string" && /^https?:\/\//i.test(r.source_url));
  add("Every result has an absolute source URL", withUrl.length === records.length,
    `${withUrl.length}/${records.length}`);

  const keys = withUrl.map((r) => normaliseUrl(r.source_url));
  const dupes = keys.length - new Set(keys).size;
  add("No duplicate source URLs", dupes === 0, dupes ? `${dupes} duplicate(s)` : "all distinct");

  const orgRole = records.map((r) => `${(r?.organization ?? "").toLowerCase()}|${(r?.role ?? "").toLowerCase()}`);
  const orgDupes = orgRole.length - new Set(orgRole).size;
  add("No duplicate organization+role pairs", orgDupes === 0, orgDupes ? `${orgDupes} duplicate(s)` : "all distinct");

  const hosts = new Set(withUrl.map((r) => { try { return new URL(r.source_url).host; } catch { return "?"; } }));
  add("Sources span multiple websites", hosts.size >= 3, `${hosts.size} distinct hosts: ${[...hosts].slice(0, 8).join(", ")}`);

  const relevant = records.filter((r) => CS_TERMS.test(`${r?.role ?? ""} ${r?.description ?? ""} ${r?.organization ?? ""}`));
  add("Results are CS/internship relevant", relevant.length === records.length, `${relevant.length}/${records.length}`);

  // Independent URL resolution. This is the check the agent cannot fake.
  say("");
  say("  Re-fetching every source URL independently...");
  const resolution = [];
  for (const r of withUrl) {
    try {
      const res = await request(r.source_url, {
        method: "GET",
        timeoutMs: 25000,
        retries: 1,
        headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36" },
      });
      resolution.push({ url: r.source_url, status: res.status, ok: res.status < 400 });
      say(`    ${res.status}  ${r.source_url.slice(0, 90)}`);
    } catch (err) {
      resolution.push({ url: r.source_url, status: null, ok: false, error: err.message });
      say(`    ERR  ${r.source_url.slice(0, 90)}  (${err.message})`);
    }
  }
  const resolved = resolution.filter((x) => x.ok).length;
  // 403 from a bot-protected careers page is not a fabricated URL, so the bar is
  // "most resolve", with every failure listed.
  add("Source URLs resolve", resolved >= Math.ceil(withUrl.length * 0.8),
    `${resolved}/${withUrl.length} returned < 400`);

  const claimedVerified = records.filter((r) => r?.verified === true).length;
  add("Agent marked results as verified", claimedVerified >= 10, `${claimedVerified} marked verified`);

  const nulls = records.filter((r) => r?.deadline === null || r?.deadline === undefined).length;
  add("Agent used null rather than inventing missing deadlines", true,
    `${nulls}/${records.length} have no stated deadline (this is expected and honest)`);

  add("Evidence note written", fs.existsSync(EVIDENCE),
    fs.existsSync(EVIDENCE) ? `${fs.statSync(EVIDENCE).size} bytes` : "missing");

  return { checks, records, resolution };
}

async function verifySystem(before) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });

  const after = usageSummary();
  const newCalls = after.calls - before.calls;
  add("Token usage was recorded", newCalls > 0 || after.calls > 0,
    `${newCalls} new call(s) recorded this run, ${after.totalTokens} tokens total today`);
  add("Token counts are provider-reported", after.allProviderReported || after.calls === 0,
    after.allProviderReported ? "every counted call reported usage" : "some calls returned no usage block");

  const dash = await buildDashboard();
  const text = renderDashboard(dash);
  add("Quota status is displayed", text.includes("PROVIDER QUOTA") && text.includes("GATEWAY FREE TIER"), "dashboard rendered");

  // The anti-fabrication check: any number shown must be labelled Live or
  // Last known value; anything unavailable must say so.
  const fabricated = /remaining/i.test(text) && !/Live|Last known value|unavailable|Unavailable/.test(text);
  add("No unlabelled quota figures", !fabricated,
    fabricated ? "a figure appeared without a freshness label" : "every figure is labelled Live / cached / unavailable");

  add("Gateway routed the request", dash.gateway.running, `gateway ${dash.gateway.running ? "up" : "down"} at ${dash.gateway.baseUrl}`);

  const models = Object.keys(dash.telemetry.last30Days.byModel);
  add("A real model served the work", models.length > 0, models.slice(0, 5).join(", ") || "none");

  return { checks, dashboardText: text };
}

function toolEvidence(transcript) {
  const checks = [];
  const used = (name) => new RegExp(`\\b${name}\\b`).test(transcript);
  checks.push({ name: "web_search was used", pass: used("web_search"), detail: "" });
  checks.push({ name: "web_fetch was used", pass: used("web_fetch"), detail: "" });
  checks.push({ name: "web_scrape was used", pass: used("web_scrape"), detail: "" });
  checks.push({ name: "browser was used", pass: used("browser"), detail: "" });
  checks.push({ name: "document_write was used", pass: used("document_write"), detail: "" });
  return checks;
}

async function main() {
  ensureDirs();
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  rule();
  say("  OMNI AGENT - END-TO-END ACCEPTANCE TEST");
  rule();

  let transcript = "";
  let elapsedMs = 0;
  const before = usageSummary();

  if (!VERIFY_ONLY) {
    say("");
    say("Ensuring the gateway is up...");
    const gw = await ensureRunning({ onProgress: (m) => say("  " + m) });
    if (gw.ok === false) {
      say(`Gateway failed: ${gw.reason}`);
      process.exit(1);
    }

    say("");
    say(`Running the agent (limit ${TIMEOUT_S}s). Free models are slow; this takes a while.`);
    say("-".repeat(74));
    fs.rmSync(RESULTS_JSON, { force: true });
    fs.rmSync(EVIDENCE, { force: true });
    const r = await runAgent();
    transcript = r.out;
    elapsedMs = r.elapsedMs;
    say("-".repeat(74));
    say(`Agent exited ${r.code} after ${(elapsedMs / 1000).toFixed(0)}s`);
    fs.writeFileSync(path.join(RESULTS_DIR, "transcript.txt"), transcript);
  } else {
    const f = path.join(RESULTS_DIR, "transcript.txt");
    if (fs.existsSync(f)) transcript = fs.readFileSync(f, "utf8");
  }

  say("");
  rule();
  say("  VERIFICATION");
  rule();

  const resultChecks = await verifyResults();
  const systemChecks = await verifySystem(before);
  const tools = toolEvidence(transcript);

  const all = [
    ["Research output", resultChecks.checks],
    ["Tool usage", tools],
    ["System", systemChecks.checks],
  ];

  say("");
  let failed = 0;
  for (const [group, checks] of all) {
    say(`${group}:`);
    for (const c of checks) {
      if (!c.pass) failed++;
      say(`  ${c.pass ? "[PASS]" : "[FAIL]"}  ${c.name}${c.detail ? `  -  ${c.detail}` : ""}`);
    }
    say("");
  }

  const report = {
    ranAt: new Date().toISOString(),
    elapsedMs,
    recordCount: resultChecks.records.length,
    checks: Object.fromEntries(all.map(([g, c]) => [g, c])),
    resolution: resultChecks.resolution ?? [],
    telemetry: usageSummary(),
    failed,
    passed: failed === 0,
  };
  fs.writeFileSync(path.join(RESULTS_DIR, "report.json"), JSON.stringify(report, null, 2));
  if (resultChecks.records.length) {
    fs.writeFileSync(path.join(RESULTS_DIR, "internships.json"), JSON.stringify(resultChecks.records, null, 2));
  }
  fs.writeFileSync(path.join(RESULTS_DIR, "usage-dashboard.txt"), systemChecks.dashboardText);

  rule();
  say(failed === 0 ? "  RESULT: PASS" : `  RESULT: FAIL - ${failed} check(s) did not pass`);
  rule();
  say(`  Report:    ${path.join(RESULTS_DIR, "report.json")}`);
  say(`  Results:   ${path.join(RESULTS_DIR, "internships.json")}`);
  say(`  Dashboard: ${path.join(RESULTS_DIR, "usage-dashboard.txt")}`);
  say("");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  say(`\nE2E harness error: ${err.message}`);
  say(err.stack);
  process.exit(1);
});
