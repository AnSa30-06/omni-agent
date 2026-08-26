// Find a Node.js executable.
//
// Needed because part of this product has to run under Node even when the
// caller does not. Inside the OpenCode plugin host the runtime is Bun, where
// `process.execPath` is the OpenCode binary - useful for nothing.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { APP_ROOT } from "./paths.mjs";

/** True when this code is running inside OpenCode's embedded Bun runtime. */
export const IS_BUN = typeof globalThis.Bun !== "undefined";

let cached = null;

/**
 * @returns {string|null} Path to a node executable, or null if none is found.
 */
export function nodeExe() {
  if (cached) return cached;

  // Under Node the answer is already in hand.
  if (!IS_BUN && /(^|[\\/])node(\.exe)?$/i.test(process.execPath)) {
    cached = process.execPath;
    return cached;
  }

  // The installed layout puts the private runtime beside the app:
  //   <install>\node\node.exe   and   <install>\app\  (= APP_ROOT)
  const bundled = path.join(APP_ROOT, "..", "node", process.platform === "win32" ? "node.exe" : "bin/node");
  if (fs.existsSync(bundled)) {
    cached = path.resolve(bundled);
    return cached;
  }

  // Development, or an install that did not bundle a runtime.
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(cmd, ["node"], { encoding: "utf8", windowsHide: true });
    const first = out.split(/\r?\n/).find((l) => l.trim());
    if (first && fs.existsSync(first.trim())) {
      cached = first.trim();
      return cached;
    }
  } catch {
    /* fall through */
  }

  return null;
}
