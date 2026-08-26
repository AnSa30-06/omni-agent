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
import { PATHS } from "../util/paths.mjs";
import { postJson } from "../util/http.mjs";
import { gatewayBaseUrl } from "../config.mjs";
import { setSecret, getSecret } from "../util/secrets.mjs";
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
  try {
    const body = await postJson(
      `${base}/api/cli/connect`,
      { password: pw, name: "omni-agent", scope: "admin" },
      { timeoutMs: 20000 }
    );
    if (!body?.token) return { ok: false, reason: "no token in response" };
    // Admin scope covers both inference and /api/* management, so one token
    // serves both roles. They are stored under separate names anyway, so a user
    // can later replace either independently.
    setSecret("omniroute.apiKey", body.token);
    setSecret("omniroute.managementKey", body.token);
    log.info("provisioned gateway token", { id: body.id, scope: body.scope });
    return { ok: true, reused: false, id: body.id, scope: body.scope };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
