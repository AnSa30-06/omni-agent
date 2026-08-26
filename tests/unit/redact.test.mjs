import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, redactString, looksSecret } from "../../src/util/redact.mjs";

test("redacts values under sensitive key names whatever their shape", () => {
  const out = redact({ apiKey: "hunter2", api_key: "x", Authorization: "Bearer abc", nested: { password: "p" } });
  assert.equal(out.apiKey, "***REDACTED***");
  assert.equal(out.api_key, "***REDACTED***");
  assert.equal(out.Authorization, "***REDACTED***");
  assert.equal(out.nested.password, "***REDACTED***");
});

test("redacts secret-shaped values found in free text", () => {
  const cases = [
    "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "sk-or-v1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  ];
  for (const c of cases) {
    const out = redactString(`the key is ${c} ok`);
    assert.ok(!out.includes(c), `leaked: ${c}`);
    assert.ok(out.includes("REDACTED"));
  }
});

test("looksSecret is the gate the diagnostics exporter relies on", () => {
  assert.equal(looksSecret("nothing to see"), false);
  assert.equal(looksSecret("token: sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA"), true);
});

test("survives cycles rather than blowing the stack", () => {
  const a = { name: "a" };
  a.self = a;
  assert.equal(redact(a).self, "[Circular]");
});

test("keeps non-sensitive data intact", () => {
  const out = redact({ model: "auto/fast", count: 3, list: ["a", "b"] });
  assert.deepEqual(out, { model: "auto/fast", count: 3, list: ["a", "b"] });
});

test("errors are redacted but keep their message shape", () => {
  const out = redact(new Error("failed with sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA"));
  assert.equal(out.name, "Error");
  assert.ok(!out.message.includes("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA"));
});
