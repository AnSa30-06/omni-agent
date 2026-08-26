// Stress tests: prove the distribution is GENERAL-PURPOSE, not tuned for one
// workload.
//
// Six tasks across coding, research, browser control, data, documents and a
// multi-step task unrelated to any of the above. Each one is verified by this
// harness rather than by reading the agent's summary - the agent saying it wrote
// a working program is not evidence that the program runs.
//
//   node tests/e2e/stress.mjs               all six
//   node tests/e2e/stress.mjs coding data   named subset
//   node tests/e2e/stress.mjs --timeout 900 per-task seconds
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PATHS, ensureDirs } from "../../src/util/paths.mjs";
import { opencodeEnv } from "../../src/setup/opencode-config.mjs";
import { locateOpenCode } from "../../src/gateway/locate.mjs";
import { ensureRunning } from "../../src/gateway/supervisor.mjs";
import { request } from "../../src/util/http.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, "results");
// Under the user profile, NOT LOCALAPPDATA. In a Windows packaged-app context
// LOCALAPPDATA is virtualised into the container's LocalCache, so OpenCode sees
// a different absolute path than this process does and refuses every write as
// external. Observed: all four tasks failed in under 40s having read nothing.
const WS = path.join(PATHS.workspace, "stress");

const argv = process.argv.slice(2);
const TIMEOUT_S = Number(argv[argv.indexOf("--timeout") + 1]) || 1200;
const only = argv.filter((a) => !a.startsWith("--") && !/^\d+$/.test(a));

const say = (s = "") => process.stdout.write(s + "\n");
const p = (f) => path.join(WS, f).replace(/\\/g, "/");

function seed() {
  fs.mkdirSync(WS, { recursive: true });
  fs.writeFileSync(
    path.join(WS, "sales.csv"),
    [
      "region,product,units,revenue,cost,quarter",
      "North,Widget,120,14400,9600,Q1",
      "North,Gadget,45,13500,11250,Q1",
      "South,Widget,200,24000,16000,Q1",
      "South,Gadget,80,24000,20000,Q1",
      "East,Widget,60,7200,4800,Q2",
      "East,Gadget,150,45000,37500,Q2",
      "West,Widget,90,10800,7200,Q2",
      "West,Gadget,30,9000,7500,Q2",
      "North,Sprocket,10,500,900,Q2",
      "South,Sprocket,5,250,450,Q2",
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(WS, "applicant.txt"),
    [
      "Name: Ada Lovelace",
      "Email: ada.lovelace@example.com",
      "Telephone: +44 20 7946 0958",
      "Preferred pizza size: Medium",
      "Topping: Bacon",
      "Delivery instructions: Leave at reception, ring the bell twice.",
    ].join("\n")
  );
}

const TASKS = {
  coding: {
    label: "Coding - write a working program",
    prompt: `Write a Python program at ${p("summarise.py")} that reads ${p("sales.csv")} and prints a summary: total revenue, total cost, total profit, and the single most profitable product line.

Then RUN it and show me the actual output. If it errors, fix it and run it again until it works.`,
    verify() {
      const f = path.join(WS, "summarise.py");
      if (!fs.existsSync(f)) return { pass: false, detail: "summarise.py was not created" };
      // The real test: does it run, here, now?
      const r = spawnSync("python", [f], { cwd: WS, encoding: "utf8", timeout: 60000, windowsHide: true });
      if (r.status !== 0) {
        return { pass: false, detail: `program exits ${r.status}: ${(r.stderr || "").slice(0, 200)}` };
      }
      const out = (r.stdout || "").toLowerCase();
      // Ground truth from the seeded data.
      const hasRevenue = /148650|148,650/.test(out);
      const hasProfit = /33450|33,450/.test(out);
      return {
        pass: hasRevenue && hasProfit,
        detail: hasRevenue && hasProfit
          ? "program runs and reports the correct totals"
          : `program runs but totals look wrong. stdout: ${(r.stdout || "").slice(0, 300)}`,
      };
    },
  },

  research: {
    label: "Web research - compare three tools with real citations",
    prompt: `Compare three current AI coding agents. For each: what it is, who makes it, and one genuine strength and one genuine limitation.

Cite a source URL for every factual claim, and FETCH each page before citing it - do not cite from a search snippet.

Save your answer as JSON to ${p("agents.json")} as an array of objects with keys: name, maker, strength, limitation, sources (array of URLs you actually fetched).`,
    async verify() {
      const f = path.join(WS, "agents.json");
      if (!fs.existsSync(f)) return { pass: false, detail: "agents.json was not created" };
      let data;
      try {
        data = JSON.parse(fs.readFileSync(f, "utf8"));
      } catch (e) {
        return { pass: false, detail: `invalid JSON: ${e.message}` };
      }
      if (!Array.isArray(data) || data.length < 3) {
        return { pass: false, detail: `expected 3+ entries, got ${Array.isArray(data) ? data.length : typeof data}` };
      }
      const urls = [...new Set(data.flatMap((d) => d.sources ?? []))].filter((u) => /^https?:/.test(u));
      if (urls.length < 3) return { pass: false, detail: `only ${urls.length} distinct source URLs` };
      let ok = 0;
      for (const u of urls.slice(0, 10)) {
        try {
          const res = await request(u, { method: "GET", timeoutMs: 20000, retries: 0 });
          if (res.status < 400) ok++;
        } catch {}
      }
      return {
        pass: ok >= Math.ceil(Math.min(urls.length, 10) * 0.7),
        detail: `${data.length} tools, ${urls.length} distinct sources, ${ok} of ${Math.min(urls.length, 10)} re-fetched OK`,
      };
    },
  },

  browser: {
    label: "Browser - fill a real form from a local file, STOP before submitting",
    prompt: `Open https://httpbin.org/forms/post in the browser.

Read ${p("applicant.txt")} and fill the form with those details: customer name, telephone, email, pizza size, topping, and the delivery instructions.

After filling every field, take a fresh snapshot and read the values back to confirm they landed.

DO NOT SUBMIT THE FORM. Stop before submission and report the filled values.

Then save what you filled as JSON to ${p("filled.json")} with keys: custname, custtel, custemail, size, topping, comments, submitted (which must be false).`,
    verify() {
      const f = path.join(WS, "filled.json");
      if (!fs.existsSync(f)) return { pass: false, detail: "filled.json was not created" };
      let d;
      try {
        d = JSON.parse(fs.readFileSync(f, "utf8"));
      } catch (e) {
        return { pass: false, detail: `invalid JSON: ${e.message}` };
      }
      const nameOk = /ada/i.test(d.custname ?? "");
      const mailOk = /ada\.lovelace@example\.com/i.test(d.custemail ?? "");
      const sizeOk = /medium/i.test(d.size ?? "");
      const notSubmitted = d.submitted === false;
      return {
        pass: nameOk && mailOk && sizeOk && notSubmitted,
        detail: `name:${nameOk} email:${mailOk} size:${sizeOk} stopped-before-submit:${notSubmitted}`,
      };
    },
  },

  data: {
    label: "Data - analyse a CSV and answer a specific question",
    prompt: `Analyse ${p("sales.csv")}. Which product line LOST money overall, and how much did it lose?

Save your answer as JSON to ${p("analysis.json")} with keys: losing_product, loss_amount (a positive number, the size of the loss), total_revenue, total_profit, method (one sentence on how you worked it out).`,
    verify() {
      const f = path.join(WS, "analysis.json");
      if (!fs.existsSync(f)) return { pass: false, detail: "analysis.json was not created" };
      let d;
      try {
        d = JSON.parse(fs.readFileSync(f, "utf8"));
      } catch (e) {
        return { pass: false, detail: `invalid JSON: ${e.message}` };
      }
      // Ground truth: Sprocket revenue 750, cost 1350 -> loses 600.
      const productOk = /sprocket/i.test(d.losing_product ?? "");
      const lossOk = Math.abs(Number(d.loss_amount) - 600) < 1;
      return {
        pass: productOk && lossOk,
        detail: productOk && lossOk
          ? "identified Sprocket losing 600, which is correct"
          : `got product=${d.losing_product} loss=${d.loss_amount}; expected Sprocket / 600`,
      };
    },
  },

  documents: {
    label: "Documents - extract a specific fact from a PDF",
    prompt: `Read the PDF at ${p("doc.pdf")} and find the total amount due and the invoice number.

Save them as JSON to ${p("invoice.json")} with keys: invoice_number, total_due, currency.`,
    setup() {
      // Build a small PDF here rather than depending on a file that may not
      // exist on the tester's machine.
      const lines = [
        "ACME SUPPLIES LTD",
        "Invoice Number: INV-2026-0473",
        "Date: 14 August 2026",
        "Item: Widget assembly x 40",
        "Subtotal: 3200.00 GBP",
        "VAT 20%: 640.00 GBP",
        "TOTAL DUE: 3840.00 GBP",
      ];
      const content = lines
        .map((l, i) => `BT /F1 12 Tf 60 ${740 - i * 26} Td (${l.replace(/[()\\]/g, "")}) Tj ET`)
        .join("\n");
      const objs = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      ];
      let pdf = "%PDF-1.4\n";
      const offsets = [];
      objs.forEach((o, i) => {
        offsets.push(pdf.length);
        pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
      });
      const xref = pdf.length;
      pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
      for (const o of offsets) pdf += `${String(o).padStart(10, "0")} 00000 n \n`;
      pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
      fs.writeFileSync(path.join(WS, "doc.pdf"), pdf, "latin1");
    },
    verify() {
      const f = path.join(WS, "invoice.json");
      if (!fs.existsSync(f)) return { pass: false, detail: "invoice.json was not created" };
      let d;
      try {
        d = JSON.parse(fs.readFileSync(f, "utf8"));
      } catch (e) {
        return { pass: false, detail: `invalid JSON: ${e.message}` };
      }
      const numOk = /INV-2026-0473/i.test(String(d.invoice_number ?? ""));
      const totOk = Math.abs(Number(String(d.total_due).replace(/[^0-9.]/g, "")) - 3840) < 1;
      return {
        pass: numOk && totOk,
        detail: `invoice_number:${numOk} total_due:${totOk} (got ${d.invoice_number} / ${d.total_due})`,
      };
    },
  },

  general: {
    label: "General - a multi-step task unrelated to any of the above",
    prompt: `Do this in order:
1. Find out what the current stable version of Node.js is, from nodejs.org itself.
2. Create a folder ${p("notes")} and write a Markdown file inside it called node-version.md containing the version, the date you checked, and the URL you got it from.
3. Create a CSV at ${p("notes/checks.csv")} with columns: item, value, source_url - one row for the Node version.
4. Tell me what you did.`,
    verify() {
      const md = path.join(WS, "notes", "node-version.md");
      const csv = path.join(WS, "notes", "checks.csv");
      if (!fs.existsSync(md)) return { pass: false, detail: "notes/node-version.md was not created" };
      if (!fs.existsSync(csv)) return { pass: false, detail: "notes/checks.csv was not created" };
      const mdText = fs.readFileSync(md, "utf8");
      const csvText = fs.readFileSync(csv, "utf8");
      const hasVersion = /\bv?\d+\.\d+\.\d+\b/.test(mdText);
      const hasUrl = /nodejs\.org/i.test(mdText);
      const csvOk = /item.*value.*source_url/i.test(csvText) && /\d+\.\d+\.\d+/.test(csvText);
      return {
        pass: hasVersion && hasUrl && csvOk,
        detail: `version-in-md:${hasVersion} nodejs.org-cited:${hasUrl} csv-well-formed:${csvOk}`,
      };
    },
  },
};

function runAgent(prompt, timeoutS) {
  const oc = locateOpenCode();
  const isCmd = /\.cmd$/i.test(oc);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(isCmd ? `"${oc}"` : oc, ["run", prompt], {
      cwd: WS,
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
      say("\n[stress] time limit reached; terminating this task");
      child.kill();
    }, timeoutS * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, ms: Date.now() - t0 });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: e.message, ms: Date.now() - t0 });
    });
  });
}

async function main() {
  ensureDirs();
  fs.mkdirSync(RESULTS, { recursive: true });
  seed();

  const gw = await ensureRunning({ onProgress: (m) => say(m) });
  if (gw.ok === false) {
    say(`Gateway failed: ${gw.reason}`);
    process.exit(1);
  }

  const names = only.length ? only.filter((n) => TASKS[n]) : Object.keys(TASKS);
  say("");
  say("=".repeat(74));
  say(`  STRESS TESTS - ${names.length} task(s), ${TIMEOUT_S}s each`);
  say("=".repeat(74));

  const results = [];
  for (const name of names) {
    const t = TASKS[name];
    say("");
    say("-".repeat(74));
    say(`  ${name}: ${t.label}`);
    say("-".repeat(74));
    t.setup?.();
    const run = await runAgent(t.prompt, TIMEOUT_S);
    let v;
    try {
      v = await t.verify();
    } catch (err) {
      v = { pass: false, detail: `verifier threw: ${err.message}` };
    }
    say("");
    say(`  ${v.pass ? "[PASS]" : "[FAIL]"} ${name} - ${v.detail}  (${(run.ms / 1000).toFixed(0)}s)`);
    results.push({ name, label: t.label, ...v, elapsedMs: run.ms, exitCode: run.code });
  }

  const passed = results.filter((r) => r.pass).length;
  say("");
  say("=".repeat(74));
  say(`  STRESS RESULT: ${passed}/${results.length} passed`);
  say("=".repeat(74));
  for (const r of results) say(`  ${r.pass ? "[PASS]" : "[FAIL]"} ${r.name.padEnd(11)} ${r.detail}`);
  say("");

  fs.writeFileSync(
    path.join(RESULTS, "stress-report.json"),
    JSON.stringify({ ranAt: new Date().toISOString(), results, passed, total: results.length }, null, 2)
  );
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  say(`\nStress harness error: ${err.message}`);
  process.exit(1);
});
