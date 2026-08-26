// Pre-push secret scan.
//
// Runs over everything that would actually be committed (git ls-files when the
// repo exists, otherwise a filtered walk) and fails the build on anything that
// looks like a live credential. Deliberately independent of src/util/redact.mjs
// so a bug in redaction cannot also blind the scanner.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { APP_ROOT } from "../src/util/paths.mjs";

const say = (s = "") => process.stdout.write(s + "\n");

const RULES = [
  { name: "Anthropic API key", re: /\bsk-ant-(api|admin)[A-Za-z0-9_-]{20,}/g },
  { name: "OpenAI key", re: /\bsk-(proj-)?[A-Za-z0-9]{32,}/g },
  { name: "OpenRouter key", re: /\bsk-or-v1-[A-Za-z0-9]{32,}/g },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { name: "GitHub token", re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}/g },
  { name: "GitHub fine-grained PAT", re: /\bgithub_pat_[A-Za-z0-9_]{50,}/g },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "OmniRoute live token", re: /\boma_live_[A-Za-z0-9_-]{20,}/g },
  { name: "Private key block", re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { name: "Generic assigned secret", re: /(?:api[-_]?key|secret|passwd|password|access[-_]?token)\s*[:=]\s*["'][A-Za-z0-9_\-\/+]{24,}["']/gi },
];

/** Files that legitimately contain secret-SHAPED text: the detectors themselves. */
const ALLOWLIST = [
  path.join("scripts", "scan-secrets.mjs"),
  path.join("src", "util", "redact.mjs"),
  path.join("tests", "unit", "redact.test.mjs"),
];

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "staging", "runtime", ".scratch", "browsers"]);
const BINARY = /\.(png|jpe?g|gif|ico|zip|exe|pdf|woff2?|ttf|mp4|webp|wasm)$/i;

function trackedFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], { cwd: APP_ROOT, encoding: "utf8" });
    const files = out.split("\0").filter(Boolean);
    if (files.length) return { files, source: "git ls-files" };
  } catch {}
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(path.relative(APP_ROOT, p));
    }
  };
  walk(APP_ROOT);
  return { files, source: "filesystem walk" };
}

function main() {
  const { files, source } = trackedFiles();
  say(`Scanning ${files.length} files (${source})`);

  const findings = [];
  let scanned = 0;

  for (const rel of files) {
    if (BINARY.test(rel)) continue;
    if (ALLOWLIST.includes(rel) || ALLOWLIST.includes(rel.split("/").join(path.sep))) continue;
    const abs = path.join(APP_ROOT, rel);
    let text;
    try {
      if (fs.statSync(abs).size > 2 * 1024 * 1024) continue;
      text = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    scanned++;
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(text))) {
        const line = text.slice(0, m.index).split("\n").length;
        findings.push({ file: rel, line, rule: rule.name, sample: m[0].slice(0, 12) + "..." });
      }
    }
  }

  // Files that must never be tracked at all, whatever their contents.
  const FORBIDDEN = ["credentials.dat", "config.json", "auth.json", ".env"];
  for (const rel of files) {
    const base = path.basename(rel);
    if (FORBIDDEN.includes(base) && !rel.includes("staging")) {
      findings.push({ file: rel, line: 0, rule: "forbidden file tracked", sample: base });
    }
  }

  say(`Scanned ${scanned} text files.`);
  if (!findings.length) {
    say("No secrets found.");
    process.exit(0);
  }

  say("");
  say("SECRETS DETECTED - do not push:");
  for (const f of findings) say(`  ${f.file}:${f.line}  ${f.rule}  (${f.sample})`);
  say("");
  say("Remove them, rotate the credential, and remember that deleting a file does");
  say("not remove it from git history.");
  process.exit(1);
}

main();
