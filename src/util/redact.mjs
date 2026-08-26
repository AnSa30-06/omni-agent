// Secret redaction shared by the logger and the diagnostics exporter.
//
// The product holds provider API keys and drives a browser against logged-in
// sites, so "never log secrets" has to be enforced in one place that every
// writer goes through, not remembered at each call site.

/** Key names whose values are always replaced, whatever they look like. */
const SENSITIVE_KEYS = /^(.*(api[-_]?key|apikey|secret|password|passwd|token|authorization|auth|cookie|session|credential|bearer|private[-_]?key|access[-_]?key)).*$/i;

/**
 * Value-shaped patterns, for secrets that appear inside free text rather than
 * as an object field. Ordered most-specific first.
 */
const VALUE_PATTERNS = [
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, "sk-ant-***REDACTED***"],
  [/\bsk-proj-[A-Za-z0-9_-]{20,}/g, "sk-proj-***REDACTED***"],
  [/\bsk-or-v1-[A-Za-z0-9_-]{20,}/g, "sk-or-v1-***REDACTED***"],
  [/\bsk-[A-Za-z0-9]{32,}/g, "sk-***REDACTED***"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "AIza***REDACTED***"],
  [/\bghp_[A-Za-z0-9]{30,}/g, "ghp_***REDACTED***"],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/g, "github_pat_***REDACTED***"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "xox***REDACTED***"],
  [/\bomr_[A-Za-z0-9_-]{16,}/g, "omr_***REDACTED***"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1***REDACTED***"],
  // Generic assignment forms: key=value / "key": "value" in raw text.
  [/((?:api[-_]?key|token|secret|password)\s*[:=]\s*["']?)([^\s"',}]{8,})/gi, "$1***REDACTED***"],
];

export function redactString(input) {
  if (typeof input !== "string") return input;
  let out = input;
  for (const [re, replacement] of VALUE_PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** Deep-redact any JSON-ish value. Non-mutating. Cycle-safe. */
export function redact(value, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, seen));
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), stack: redactString(value.stack || "") };
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEYS.test(k) ? "***REDACTED***" : redact(v, seen);
  }
  return out;
}

/** True when a string still contains something that looks like a live secret. */
export function looksSecret(text) {
  if (typeof text !== "string") return false;
  return VALUE_PATTERNS.some(([re]) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}
