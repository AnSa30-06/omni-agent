// The browser host - the Node process the plugin forwards browser work to.
//
// This is the mechanism that makes the browser usable at all from inside
// OpenCode, where Playwright cannot reach Chromium. It went unnoticed for a
// while precisely because every test drove browser.mjs directly, under Node,
// which is not how the product actually calls it. These tests drive the wire.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as B from "../../src/tools/browser.mjs";
import { PATHS, pkg } from "../../src/util/paths.mjs";

let child;
let host;

async function call(method, args = [], token = host.token) {
  const res = await fetch(`http://127.0.0.1:${host.port}/call`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-omni-token": token },
    body: JSON.stringify({ method, args }),
  });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  if (!B.chromiumInstalled()) throw new Error("Chromium is not installed; run `omni-agent setup --browser`");
  child = spawn(process.execPath, [pkg("src", "tools", "browser-host.mjs")], {
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: PATHS.browsers },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  host = JSON.parse(
    await new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("the host printed no handshake within 30s")), 30_000);
      child.stdout.on("data", (b) => {
        buf += b.toString();
        const nl = buf.indexOf("\n");
        if (nl !== -1) {
          clearTimeout(timer);
          resolve(buf.slice(0, nl));
        }
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    })
  );
});

after(() => {
  child?.kill();
});

test("the handshake carries a port and a token, on loopback only", async () => {
  assert.ok(host.port > 0);
  assert.equal(host.token.length, 48, "expected 24 random bytes as hex");
  const res = await fetch(`http://127.0.0.1:${host.port}/health`);
  assert.equal(res.status, 200);
});

test("a call without the right token is refused", async () => {
  const r = await call("navigate", ["https://example.com/"], "0".repeat(48));
  assert.equal(r.status, 401);
});

test("a method that is not on the allowlist is refused", async () => {
  // The method name comes off the wire, so this must never resolve to whatever
  // happens to be exported.
  const r = await call("close; process.exit", []);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /unknown method/);
});

test("a real page is driven over the wire", async () => {
  const r = await call("navigate", ["https://example.com/"]);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.value.status, 200);
  assert.equal(r.body.value.title, "Example Domain");
});

test("a tool error comes back as an error, not as a result", async () => {
  const r = await call("click", ["e9999"]);
  assert.equal(r.status, 200, "the transport succeeded");
  assert.equal(r.body.ok, false, "the call did not");
  assert.match(r.body.error, /e9999/);
});

test("the browser closes on request", async () => {
  const r = await call("close");
  assert.equal(r.body.ok, true);
});
