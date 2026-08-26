// HTTP with bounded exponential backoff.
//
// Retries only idempotent-by-intent failures: network errors, 408, 429 and 5xx.
// A 4xx that is not 408/429 is a caller error and retrying it just burns time.
// Nothing here retries a POST that the caller marked non-idempotent.
import { logger } from "./log.mjs";

const log = logger("http");

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

function backoffMs(attempt, retryAfterHeader) {
  if (retryAfterHeader) {
    const secs = Number(retryAfterHeader);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30_000);
    const when = Date.parse(retryAfterHeader);
    if (Number.isFinite(when)) return Math.min(Math.max(when - Date.now(), 0), 30_000);
  }
  const base = Math.min(500 * 2 ** attempt, 8_000);
  return base + Math.floor(Math.random() * 250); // jitter, so parallel callers desync
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} url
 * @param {RequestInit & {timeoutMs?:number, retries?:number, idempotent?:boolean}} [opts]
 * @returns {Promise<Response>}
 */
export async function request(url, opts = {}) {
  const { timeoutMs = 30_000, retries = 3, idempotent = true, ...init } = opts;
  const maxAttempts = idempotent ? retries + 1 : 1;
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ac.signal });
      clearTimeout(timer);
      if (RETRYABLE_STATUS.has(res.status) && attempt < maxAttempts - 1) {
        const wait = backoffMs(attempt, res.headers.get("retry-after"));
        log.warn(`retrying ${res.status}`, { url, attempt, wait });
        await sleep(wait);
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < maxAttempts - 1) {
        const wait = backoffMs(attempt, null);
        log.warn(`retrying network error`, { url, attempt, wait, err: err.message });
        await sleep(wait);
        continue;
      }
    }
  }
  throw lastErr ?? new Error(`request failed: ${url}`);
}

/** GET + JSON, throwing HttpError on non-2xx. */
export async function getJson(url, opts = {}) {
  const res = await request(url, { ...opts, method: "GET" });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, url, text.slice(0, 500));
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response from ${url}: ${text.slice(0, 200)}`);
  }
}

/** POST JSON + JSON. Not retried unless the caller opts in. */
export async function postJson(url, body, opts = {}) {
  const res = await request(url, {
    idempotent: false,
    ...opts,
    method: "POST",
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, url, text.slice(0, 500));
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response from ${url}: ${text.slice(0, 200)}`);
  }
}
