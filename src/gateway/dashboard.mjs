// Opening the gateway's own dashboard.
//
// The bundled gateway is a full web application - 142 pages of providers,
// compression studios, analytics, search tools and settings - and until now
// nothing in this product ever told the user it was there. It is running on
// their machine either way.
//
// It sits behind a password we generate during setup and store; the user has
// never seen it. This module shows it to them so they can sign in. It does NOT
// type it for them: filling a password field on someone's behalf is not this
// program's job, and a person who cannot see the password cannot use the
// dashboard from any other browser either.
import { spawn } from "node:child_process";
import { gatewayBaseUrl } from "../config.mjs";
import { dashboardPassword } from "./admin.mjs";

/**
 * Named destinations, so nobody has to remember a route.
 * Keys are what the user types after `omni-agent dashboard`.
 */
export const PAGES = {
  home: { path: "/dashboard", label: "Overview" },
  search: { path: "/dashboard/search-tools", label: "Search tools - web search and scraping providers" },
  free: { path: "/dashboard/free-tiers", label: "Free tiers - every provider with a free allowance" },
  rankings: { path: "/dashboard/free-provider-rankings", label: "Free provider rankings" },
  providers: { path: "/dashboard/providers", label: "Providers - connect an account or paste a key" },
  compression: { path: "/dashboard/compression", label: "Token saving" },
  studio: { path: "/dashboard/compression/studio", label: "Compression studio - try a mode on real text" },
  models: { path: "/dashboard/combos", label: "Model combos and routing" },
  usage: { path: "/dashboard/usage", label: "Usage" },
  quota: { path: "/dashboard/quota", label: "Quota" },
  keys: { path: "/dashboard/tokens", label: "Access tokens" },
  settings: { path: "/dashboard/settings", label: "All settings" },
  logs: { path: "/dashboard/logs", label: "Request logs" },
};

export function dashboardUrl(page = "home") {
  const entry = PAGES[page];
  if (!entry) return null;
  return `${gatewayBaseUrl()}${entry.path}`;
}

/** Open a URL in the user's default browser. */
export function openInBrowser(url) {
  try {
    // `start` is a cmd builtin, hence the shell; the empty "" is the window
    // title argument, without which a quoted URL is swallowed as the title.
    const child = spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/** Put text on the Windows clipboard, so a generated password need not be retyped. */
export function copyToClipboard(text) {
  return new Promise((resolve) => {
    try {
      const child = spawn("clip", [], { stdio: ["pipe", "ignore", "ignore"], shell: true, windowsHide: true });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
      child.stdin.end(text);
    } catch {
      resolve(false);
    }
  });
}

export function password() {
  return dashboardPassword();
}
