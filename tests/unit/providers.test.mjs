// The free-provider catalogue, checked against the code that consumes it.
//
// Both of these caught real bugs before release. They are cheap and they guard
// the two ways this catalogue can be wrong without anything crashing.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { catalogue, setupSteps, renderSetup } from "../../src/setup/providers.mjs";
import { pkg } from "../../src/util/paths.mjs";
import { DEFAULTS } from "../../src/config.mjs";

test("search keys are stored under the names the search code actually reads", () => {
  // The catalogue once used brave.apiKey / tavily.apiKey / serper.apiKey while
  // search.mjs resolved search.brave / search.tavily / search.serper. Adding a
  // key appeared to work and then did nothing at all.
  const src = fs.readFileSync(pkg("src", "tools", "search.mjs"), "utf8") +
    fs.readFileSync(pkg("src", "tools", "web.mjs"), "utf8");
  for (const s of catalogue().search) {
    assert.ok(
      src.includes(`"${s.secret}"`),
      `${s.id} stores its key as "${s.secret}", which nothing in search.mjs or web.mjs resolves`
    );
    assert.ok(src.includes(`"${s.env}"`), `${s.id} names env var ${s.env}, which nothing reads`);
  }
});

test("every keyless provider named in the catalogue is really in the default chain", () => {
  const order = DEFAULTS.search.order;
  for (const k of catalogue().keyless ?? []) {
    assert.ok(order.includes(k.id), `${k.id} is described to the user but is not in the default search order`);
  }
});

test("every provider that needs a credential has setup instructions", () => {
  for (const s of catalogue().search) {
    const st = setupSteps(s.id);
    assert.equal(st.ok, true, `${s.id} has no setup entry`);
    assert.ok(st.steps.length >= 2, `${s.id} has ${st.steps.length} step(s)`);
    // The last actionable step must be the command that actually stores it.
    assert.ok(
      st.steps.some((x) => x.includes(`provider add ${s.id}`)),
      `${s.id} never tells the user the command to run`
    );
  }
});

test("setup instructions render with sequential numbering", () => {
  const out = renderSetup(setupSteps("searxng"));
  const nums = [...out.matchAll(/^ {2}(\d+)\./gm)].map((m) => Number(m[1]));
  assert.deepEqual(nums, nums.map((_, i) => i + 1), "continuation lines must not consume a step number");
});

test("a signup link is present for anything that needs an account", () => {
  for (const s of catalogue().search) {
    assert.match(s.signup ?? "", /^https:\/\//, `${s.id} has no signup URL`);
  }
});
