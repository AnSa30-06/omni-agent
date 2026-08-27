// Obtain a credential for the bundled gateway.
//
// Why this exists at all: the OmniRoute OpenCode plugin refuses to register its
// provider block unless it finds a non-empty api key in OpenCode's auth.json
// ("config shim skipped: no apiKey"). Our gateway runs with REQUIRE_API_KEY
// false, so inference does not need one - but OpenCode will not see any models
// without it. So setup must mint a real key rather than leave the user to.
//
// The mechanism is OmniRoute's own supported CLI flow: POST /api/cli/connect
// with the instance's management password returns a scoped token. We generated
// that password ourselves in ensureGatewayEnv(), so no human has to type
// anything, and the token is admin-scoped, which is also what unlocks the
// /api/* quota and pricing endpoints the usage dashboard needs.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { PATHS } from "../util/paths.mjs";
import { postJson } from "../util/http.mjs";
import { gatewayBaseUrl } from "../config.mjs";
import { setSecret, getSecret } from "../util/secrets.mjs";
import { locateOmniRoute } from "./locate.mjs";
import { ensureRunning, stop as stopGateway } from "./supervisor.mjs";
import { logger } from "../util/log.mjs";

const log = logger("provision");

function adminPassword() {
  try {
    const text = fs.readFileSync(path.join(PATHS.gatewayData, ".env"), "utf8");
    return /^INITIAL_PASSWORD=(.*)$/m.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}


/**
 * Force the gateway database's admin password to the one in our generated .env.
 *
 * Needed because the password and the database that validates it live in two
 * places that can get out of step. `ensureGatewayEnv()` writes INITIAL_PASSWORD
 * once, and OmniRoute only reads it when it initialises a fresh database - so
 * if the .env is lost while storage.sqlite survives, setup regenerates a
 * password the database will never accept and every /api/* call 401s forever.
 * Measured exactly that after the data directory was partially deleted.
 *
 * OmniRoute ships the supported way out: `omniroute-reset-password
 * --password-stdin`, which resolves DATA_DIR the same way the server does.
 */
function resetGatewayPassword(password) {
  const found = locateOmniRoute();
  if (!found?.root) return Promise.resolve({ ok: false, reason: "omniroute-not-installed" });
  const script = path.join(found.root, "bin", "reset-password.mjs");
  if (!fs.existsSync(script)) return Promise.resolve({ ok: false, reason: "reset-password tool not found" });

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, "--password-stdin"], {
      env: { ...process.env, DATA_DIR: PATHS.gatewayData },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let tail = "";
    const cap = (b) => {
      tail = (tail + b.toString()).slice(-1500);
    };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    child.on("error", (err) => resolve({ ok: false, reason: err.message }));
    child.on("close", (code) => resolve(code === 0 ? { ok: true } : { ok: false, reason: `reset exited ${code}`, detail: tail }));
    child.stdin.end(password);
  });
}

/**
 * Mint (or reuse) a gateway token and store it in the credential store.
 * @param {{force?:boolean}} [opts]
 */
export async function provisionGatewayToken(opts = {}) {
  if (!opts.force) {
    const existing = getSecret("omniroute.apiKey");
    if (existing) return { ok: true, reused: true };
  }

  const pw = adminPassword();
  if (!pw) {
    return {
      ok: false,
      reason: "no-admin-password",
      remedy:
        "The gateway's generated .env is missing. Delete " +
        PATHS.gatewayData +
        " and run `omni-agent setup` again to regenerate it.",
    };
  }

  const base = gatewayBaseUrl();
  const connect = () =>
    postJson(
      `${base}/api/cli/connect`,
      { password: pw, name: "omni-agent", scope: "admin" },
      { timeoutMs: 20000 }
    );

  let body;
  try {
    body = await connect();
  } catch (err) {
    // A 401 here means the .env password and the database disagree. Nothing the
    // user did wrong, and nothing they can fix by re-running setup - the
    // regenerated password is exactly what the database is rejecting.
    if (!/\b401\b/.test(err.message)) return { ok: false, reason: err.message };
    log.warn("gateway rejected the generated password; resetting it", {});
    const reset = await resetGatewayPassword(pw);
    if (reset.ok) {
      // The reset writes to storage.sqlite, but a running server has already
      // read the password into memory - verified: the reset exits 0 and the
      // very next connect still 401s until the process is restarted.
      await stopGateway();
      await ensureRunning();
    }
    if (!reset.ok) {
      return {
        ok: false,
        reason: `the gateway rejected its own generated password and it could not be reset (${reset.reason})`,
        remedy:
          "Stop the gateway, delete " + PATHS.gatewayData + " and run `omni-agent setup` again. " +
          "That discards gateway history but not your saved keys.",
      };
    }
    try {
      body = await connect();
    } catch (err2) {
      return { ok: false, reason: `still rejected after a password reset: ${err2.message}` };
    }
    log.info("recovered gateway password", {});
  }

  if (!body?.token) return { ok: false, reason: "no token in response" };

  // Admin scope covers both inference and /api/* management, so one token
  // serves both roles. They are stored under separate names anyway, so a user
  // can later replace either independently.
  setSecret("omniroute.apiKey", body.token);
  setSecret("omniroute.managementKey", body.token);
  log.info("provisioned gateway token", { id: body.id, scope: body.scope });
  return { ok: true, reused: false, id: body.id, scope: body.scope };
}
