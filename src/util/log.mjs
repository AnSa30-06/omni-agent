// Diagnostics logging. Every write goes through redact(), so a secret cannot
// reach the log file even if a caller passes a whole request object.
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "./paths.mjs";
import { redact, redactString } from "./redact.mjs";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const level = LEVELS[(process.env.OMNI_AGENT_LOG_LEVEL || "info").toLowerCase()] ?? LEVELS.info;

let stream = null;
function out() {
  if (stream) return stream;
  try {
    fs.mkdirSync(PATHS.logs, { recursive: true });
    const file = path.join(PATHS.logs, `omni-agent-${new Date().toISOString().slice(0, 10)}.log`);
    stream = fs.createWriteStream(file, { flags: "a" });
  } catch {
    stream = { write() {} };
  }
  return stream;
}

function emit(lvl, scope, msg, data) {
  if (LEVELS[lvl] < level) return;
  const line = {
    ts: new Date().toISOString(),
    level: lvl,
    scope,
    msg: redactString(String(msg)),
    ...(data === undefined ? {} : { data: redact(data) }),
  };
  try {
    out().write(JSON.stringify(line) + "\n");
  } catch {}
  if (lvl === "error" || lvl === "warn" || process.env.OMNI_AGENT_LOG_STDERR === "1") {
    process.stderr.write(`[${lvl}] ${scope}: ${line.msg}\n`);
  }
}

export function logger(scope) {
  return {
    debug: (m, d) => emit("debug", scope, m, d),
    info: (m, d) => emit("info", scope, m, d),
    warn: (m, d) => emit("warn", scope, m, d),
    error: (m, d) => emit("error", scope, m, d),
  };
}

export function logDir() {
  return PATHS.logs;
}
