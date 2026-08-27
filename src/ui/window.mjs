// A real application window, without shipping Electron.
//
// This product already downloads a full Chromium during setup, because the
// agent needs a real browser to do web work. Chromium's `--app=URL` mode opens
// that same binary as a chromeless window - no tab strip, no address bar, its
// own taskbar button. So the desktop window costs 0 MB extra instead of the
// ~150 MB an Electron shell would add on top of a browser we already have.
//
// ⚠️ HEADED CHROMIUM HAS A DEPENDENCY THE HEADLESS ONE DOES NOT. Measured on
// this machine 2026-08-27: `chrome.exe --version` fails with "the application
// has failed to start because its side-by-side configuration is incorrect",
// which is Windows for a missing Visual C++ runtime. Through Node that surfaces
// as the far less helpful `spawn UNKNOWN`, and it fails identically from
// PowerShell, from `cmd /c start`, and through Playwright's own launcher - so
// it is the machine, not the caller. Playwright's headless `launch()` works on
// the same box because it runs chrome-headless-shell, a different binary with
// fewer dependencies, which is exactly why the agent's browser tools are fine
// while the window is not.
//
// So the fallback is not decoration: it is the path a machine without the
// runtime will actually take, and it has to be automatic.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { PATHS } from "../util/paths.mjs";
import { logger } from "../util/log.mjs";

const log = logger("ui/window");

/**
 * Browsers that can open a chromeless app window, best first.
 *
 * Edge matters most here: it is present on every Windows 10 and 11 install,
 * it takes the same `--app=` flag, and it does not carry the runtime problem
 * the bundled Chromium hit on this machine. So the window works out of the box
 * on a normal Windows box even when the bundled browser cannot start.
 */
function systemBrowsers() {
  const pf = process.env.ProgramFiles ?? "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA ?? "";
  return [
    ["Microsoft Edge", path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe")],
    ["Microsoft Edge", path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe")],
    ["Google Chrome", path.join(pf, "Google", "Chrome", "Application", "chrome.exe")],
    ["Google Chrome", path.join(pf86, "Google", "Chrome", "Application", "chrome.exe")],
    ["Google Chrome", path.join(local, "Google", "Chrome", "Application", "chrome.exe")],
  ].filter(([, p]) => p && fs.existsSync(p));
}

/** The Chromium that setup downloaded, or null when it is missing. */
export function chromiumExe() {
  try {
    const dirs = fs
      .readdirSync(PATHS.browsers)
      .filter((d) => /^chromium-/.test(d))
      .sort();
    for (const d of dirs.reverse()) {
      for (const sub of ["chrome-win64", "chrome-win", "chrome-linux"]) {
        for (const exe of ["chrome.exe", "chrome"]) {
          const p = path.join(PATHS.browsers, d, sub, exe);
          if (fs.existsSync(p)) return p;
        }
      }
    }
  } catch {}
  return null;
}

/**
 * Can the headed browser actually start on this machine?
 *
 * Checked by running it, because the file existing proves nothing here - the
 * whole failure mode is a present, correct binary that Windows refuses to load.
 */
export function canOpenAppWindow() {
  const exe = chromiumExe();
  if (!exe) return { ok: false, reason: "the bundled browser is not installed" };
  const r = spawnSync(exe, ["--version"], { windowsHide: true, timeout: 15_000 });
  if (r.error) {
    const sxs = /UNKNOWN/i.test(r.error.code ?? "") || /side-by-side/i.test(String(r.stderr));
    return {
      ok: false,
      reason: sxs
        ? "the bundled browser cannot start on this machine (missing Visual C++ runtime)"
        : r.error.message,
      remedy: sxs ? "Install the Microsoft Visual C++ Redistributable (x64), then reopen Omni Agent." : null,
    };
  }
  if (r.status !== 0) return { ok: false, reason: `the bundled browser exited ${r.status}` };
  return { ok: true };
}

function openInDefaultBrowser(url) {
  try {
    // `start` is a cmd builtin, hence the shell; the empty "" is the window
    // title argument, without which a quoted URL is swallowed as the title.
    const child = spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    return { ok: true, mode: "default-browser" };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * Open the UI in its own window, falling back to the default browser.
 *
 * @param {string} url
 */
export function openWindow(url, { width = 1440, height = 900 } = {}) {
  // Its own profile, separate from the automation one: the window keeps its
  // size and position, and the agent's browsing cannot log itself into
  // anything this window can see.
  const profile = path.join(PATHS.home, "ui-window");
  fs.mkdirSync(profile, { recursive: true });

  const candidates = [];
  const bundled = canOpenAppWindow();
  if (bundled.ok) candidates.push(["the bundled browser", chromiumExe()]);
  candidates.push(...systemBrowsers());

  const failures = [];
  for (const [label, exe] of candidates) {
    try {
      const child = spawn(
        exe,
        [
          `--app=${url}`,
          `--user-data-dir=${profile}`,
          `--window-size=${width},${height}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-features=Translate,MediaRouter",
        ],
        { detached: true, stdio: "ignore", windowsHide: false },
      );
      child.unref();
      log.info("ui window opened", { via: label, url });
      // The handle is returned so the caller can shut the agent down when the
      // window is closed - that is what makes this behave like an application
      // rather than a server someone forgot to stop.
      return { ok: true, mode: "app-window", via: label, pid: child.pid, child };
    } catch (err) {
      failures.push(`${label}: ${err.code ?? err.message}`);
    }
  }

  log.warn("no app window available; using the default browser", { failures, bundled: bundled.reason });
  const r = openInDefaultBrowser(url);
  return {
    ...r,
    degraded: true,
    reason: bundled.ok ? failures.join("; ") : bundled.reason,
    remedy: bundled.remedy,
  };
}
