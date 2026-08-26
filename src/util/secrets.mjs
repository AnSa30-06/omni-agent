// Credential storage.
//
// Windows: values are encrypted with DPAPI via PowerShell's SecureString
// cmdlets, which bind the ciphertext to the current Windows user account. That
// gives OS-backed protection with no native module to compile in the installer.
// Other platforms: a 0600 file, which is the same guarantee the OpenCode and
// omniroute CLIs give their own auth files.
//
// Nothing here ever writes into the repository - PATHS.secrets is under the
// per-user data directory.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PATHS } from "./paths.mjs";

const IS_WIN = process.platform === "win32";
const PS = process.env.COMSPEC
  ? path.join(process.env.SystemRoot || "C:\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  : "powershell.exe";

function ps(script) {
  return execFileSync(PS, ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}

/** Encrypt one string. Returns an opaque token safe to write to disk. */
export function protect(plaintext) {
  if (!IS_WIN) return "plain:" + Buffer.from(plaintext, "utf8").toString("base64");
  const b64 = Buffer.from(plaintext, "utf8").toString("base64");
  const out = ps(
    `$b=[Convert]::FromBase64String('${b64}');` +
      `$s=[Text.Encoding]::UTF8.GetString($b);` +
      `$ss=ConvertTo-SecureString -String $s -AsPlainText -Force;` +
      `ConvertFrom-SecureString -SecureString $ss`
  );
  return "dpapi:" + out;
}

/** Decrypt a token produced by protect(). Returns null if it cannot be read. */
export function unprotect(token) {
  if (typeof token !== "string") return null;
  if (token.startsWith("plain:")) return Buffer.from(token.slice(6), "base64").toString("utf8");
  if (!token.startsWith("dpapi:")) return null;
  if (!IS_WIN) return null;
  try {
    const enc = token.slice(6);
    const out = ps(
      `$ss=ConvertTo-SecureString -String '${enc}';` +
        `$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss);` +
        `$s=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($p);` +
        `[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p);` +
        `[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s))`
    );
    return Buffer.from(out, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(PATHS.secrets, "utf8"));
  } catch {
    return {};
  }
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(PATHS.secrets), { recursive: true });
  fs.writeFileSync(PATHS.secrets, JSON.stringify(store, null, 2), { mode: 0o600 });
  if (!IS_WIN) {
    try {
      fs.chmodSync(PATHS.secrets, 0o600);
    } catch {}
  }
}

/** Store one named credential. Passing null/"" deletes it. */
export function setSecret(name, value) {
  const store = readStore();
  if (value == null || value === "") delete store[name];
  else store[name] = protect(String(value));
  writeStore(store);
}

/** Read one named credential, or null. */
export function getSecret(name) {
  const raw = readStore()[name];
  return raw ? unprotect(raw) : null;
}

/** Names only - never values. Safe to print and to log. */
export function listSecretNames() {
  return Object.keys(readStore()).sort();
}

export function hasSecret(name) {
  return Object.prototype.hasOwnProperty.call(readStore(), name);
}

/**
 * Resolve a credential from the store, falling back to the process environment
 * so a technical user or CI can run without the store at all.
 */
export function resolveSecret(name, envVar) {
  const fromStore = getSecret(name);
  if (fromStore) return fromStore;
  if (envVar && process.env[envVar]) return process.env[envVar];
  return null;
}
