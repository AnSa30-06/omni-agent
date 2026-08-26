// Write the OpenCode configuration with the model the current routing mode
// implies.
//
// Kept separate from opencode-config.mjs because resolving the model needs the
// live catalogue, and opencode-config.mjs must stay usable (and synchronous)
// when the gateway is down - a user whose gateway will not start still needs a
// config file written so `omni-agent doctor` can tell them why.
import { writeOpenCodeConfig, writeOpenCodeAuth } from "./opencode-config.mjs";
import { getSecret } from "../util/secrets.mjs";
import { GatewayClient } from "../gateway/client.mjs";
import { selectModel } from "../routing/select.mjs";
import { getCatalogue } from "../routing/catalog.mjs";
import { loadConfig } from "../config.mjs";
import { logger } from "../util/log.mjs";

const log = logger("apply-config");

/**
 * Resolve the combo the agent should run on, for the configured mode.
 * Returns null when the gateway cannot be reached, in which case the config is
 * written without a pinned model and OpenCode falls back to its own choice.
 */
export async function resolveAgentModel() {
  const cfg = loadConfig();
  if (cfg.routing.pinnedModel) return cfg.routing.pinnedModel;
  try {
    const client = new GatewayClient();
    if (!(await client.isUp(4000))) return null;
    const catalogue = await getCatalogue({ force: true, client });
    // The agent's main job is agentic coding and tool use, so that is the
    // intent the default is resolved for.
    const r = await selectModel({ task: "code", needsTools: true, catalogue });
    return r.model;
  } catch (err) {
    log.warn("could not resolve an agent model", { err: err.message });
    return null;
  }
}

/**
 * Write opencode.json + auth.json for the current settings.
 * @returns {Promise<{configPath:string, model:string|null, omnirouteWired:boolean}>}
 */
export async function applyConfig() {
  const apiKey = getSecret("omniroute.apiKey");
  const defaultModel = await resolveAgentModel();
  const wrote = writeOpenCodeConfig({ apiKey, defaultModel });
  const auth = writeOpenCodeAuth(apiKey);
  log.info("applied config", { model: defaultModel, wired: wrote.omnirouteWired });
  return { ...wrote, model: defaultModel, authWritten: auth.written };
}
