// Diagnostics export.
//
// Produces one JSON file a user can send to someone for help. Everything in it
// goes through redact() first, and the result is then re-scanned: if anything
// still looks like a live secret the export fails loudly rather than shipping
// it. A "sanitised" bundle that is not sanitised is worse than none.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PATHS, ensureDirs } from "./paths.mjs";
import { redact, looksSecret } from "./redact.mjs";
import { loadConfig } from "../config.mjs";
import { listSecretNames } from "./secrets.mjs";
import { locateOmniRoute, locateOpenCode } from "../gateway/locate.mjs";
import { runDoctor } from "../setup/doctor.mjs";
import { rangeSummary } from "../usage/telemetry.mjs";

function tailFile(file, lines = 200) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").slice(-lines).join("\n");
  } catch {
    return null;
  }
}

export async function exportDiagnostics({ deep = false } = {}) {
  ensureDirs();

  const logFiles = {};
  try {
    for (const f of fs.readdirSync(PATHS.logs).slice(-5)) {
      logFiles[f] = tailFile(path.join(PATHS.logs, f), 200);
    }
  } catch {}

  const doctor = await runDoctor({ deep }).catch((err) => ({ error: err.message }));

  const bundle = redact({
    generatedAt: new Date().toISOString(),
    app: { version: JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version },
    system: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      node: process.versions.node,
      totalMemMB: Math.round(os.totalmem() / 1048576),
      cpus: os.cpus().length,
    },
    install: {
      home: PATHS.home,
      omniroute: locateOmniRoute(),
      opencode: locateOpenCode(),
    },
    // Config contains no secrets by construction; redact() runs over it anyway.
    config: loadConfig(),
    // Names only. Never values.
    storedCredentialNames: listSecretNames(),
    doctor,
    telemetry30d: rangeSummary(30),
    logs: logFiles,
  });

  const text = JSON.stringify(bundle, null, 2);

  // Second gate: re-scan the rendered output, not just the object.
  if (looksSecret(text)) {
    throw new Error(
      "diagnostics export aborted: the sanitised bundle still matched a secret pattern. " +
        "This is a bug in redaction - please report it rather than sharing the file."
    );
  }

  const dest = path.join(PATHS.logs, `diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(dest, text);
  return { path: dest, bytes: text.length, redacted: true };
}
