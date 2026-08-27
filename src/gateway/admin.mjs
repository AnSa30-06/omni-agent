// Talking to the gateway's management API.
//
// OmniRoute protects its management routes two different ways, and which one a
// route uses is not guessable from its path:
//
//   BearerAuth              an API key. /api/providers, /api/keys, /api/combos,
//                           /api/agent-skills, /api/usage/* all take this.
//   ManagementSessionAuth   an `auth_token` COOKIE from POST /api/auth/login.
//                           /api/settings/* takes this, and rejects a bearer
//                           token with 401.
//
// Measured 2026-08-27: the admin-scoped token that reads /api/providers fine
// returns `unauthorized` on /api/settings/compression. So this module holds a
// dashboard session alongside the token and retries with the other credential
// rather than making every caller know which is which.
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../util/paths.mjs";
import { gatewayBaseUrl } from "../config.mjs";
import { getSecret } from "../util/secrets.mjs";
import { logger } from "../util/log.mjs";

const log = logger("admin");

/** Cached dashboard session cookie. Cheap to re-mint, so no disk persistence. */
let session = null;

function adminPassword() {
  try {
    const text = fs.readFileSync(path.join(PATHS.gatewayData, ".env"), "utf8");
    return /^INITIAL_PASSWORD=(.*)$/m.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Log in to the dashboard and keep the `auth_token` cookie.
 * @returns {Promise<string|null>} a Cookie header value, or null
 */
export async function ensureSession({ force = false } = {}) {
  if (session && !force) return session;
  const password = adminPassword();
  if (!password) return null;
  try {
    const res = await fetch(`${gatewayBaseUrl()}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      log.warn("dashboard login failed", { status: res.status });
      return null;
    }
    const cookies = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")].filter(Boolean);
    const auth = cookies.map((c) => c.split(";")[0]).filter((c) => c.startsWith("auth_token="));
    if (!auth.length) return null;
    session = auth.join("; ");
    return session;
  } catch (err) {
    log.warn("dashboard login errored", { err: err.message });
    return null;
  }
}

/** The dashboard password, for showing the user so they can sign in themselves. */
export function dashboardPassword() {
  return adminPassword();
}

async function send(method, pathname, body, { cookie, bearer } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${gatewayBaseUrl()}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, ok: res.ok, data };
}

/**
 * Call a management endpoint, working out which credential it wants.
 *
 * Tries the bearer token first (most routes), then the dashboard session on a
 * 401. Returns `{ok:false, reason}` rather than throwing, because "the gateway
 * is not configured yet" is an ordinary state on a fresh install and every
 * caller has to render it rather than crash.
 *
 * @param {"GET"|"POST"|"PUT"|"PATCH"|"DELETE"} method
 * @param {string} pathname e.g. "/api/settings/compression"
 * @param {any} [body]
 */
export async function admin(method, pathname, body) {
  const bearer = getSecret("omniroute.managementKey") || getSecret("omniroute.apiKey");
  try {
    if (bearer) {
      const first = await send(method, pathname, body, { bearer });
      if (first.status !== 401 && first.status !== 403) {
        return first.ok
          ? { ok: true, data: first.data }
          : { ok: false, reason: `HTTP ${first.status}`, status: first.status, data: first.data };
      }
    }
    const cookie = await ensureSession();
    if (!cookie) {
      return {
        ok: false,
        reason: bearer ? "unauthorized" : "not-provisioned",
        remedy: "Run `omni-agent setup --non-interactive` to mint gateway credentials.",
      };
    }
    let res = await send(method, pathname, body, { cookie });
    if (res.status === 401) {
      // The session expired; one forced re-login, then give up.
      const fresh = await ensureSession({ force: true });
      if (fresh) res = await send(method, pathname, body, { cookie: fresh });
    }
    return res.ok
      ? { ok: true, data: res.data }
      : { ok: false, reason: `HTTP ${res.status}`, status: res.status, data: res.data };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
