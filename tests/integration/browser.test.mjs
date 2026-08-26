// Browser integration tests. These drive a real Chromium against real pages.
//
// The submit-gate tests are the important ones: they are the only automated
// proof that the confirmation boundary described in docs/security.md actually
// holds, in both directions.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as B from "../../src/tools/browser.mjs";

const FORM = "https://httpbin.org/forms/post";

before(() => {
  if (!B.chromiumInstalled()) throw new Error("Chromium is not installed; run `omni-agent setup --browser`");
});

after(async () => {
  await B.close();
});

test("navigates and reports the real status and title", async () => {
  const r = await B.navigate("https://example.com/");
  assert.equal(r.status, 200);
  assert.equal(r.title, "Example Domain");
});

test("snapshot stamps refs on interactive elements", async () => {
  await B.navigate(FORM);
  const s = await B.snapshot();
  assert.ok(s.refCount >= 10, `expected the form's controls, got ${s.refCount}`);
  assert.match(s.snapshot, /textbox .*\[ref=e\d+\]/);
  assert.match(s.snapshot, /button .*\[ref=e\d+\]/);
  // Labels must be resolved, otherwise the agent cannot tell fields apart.
  assert.match(s.snapshot, /Customer name/);
});

test("typing, checking and selecting actually land in the DOM", async () => {
  await B.navigate(FORM);
  const s = await B.snapshot();
  const nameRef = /textbox "Customer name:" \[ref=(e\d+)\]/.exec(s.snapshot)?.[1];
  const radioRef = /radio "Medium" \[ref=(e\d+)\]/.exec(s.snapshot)?.[1];
  const boxRef = /checkbox "Bacon" \[ref=(e\d+)\]/.exec(s.snapshot)?.[1];
  assert.ok(nameRef && radioRef && boxRef, "could not locate the expected controls");

  await B.type(nameRef, "Ada Lovelace");
  await B.setChecked(radioRef, true);
  await B.setChecked(boxRef, true);

  const after2 = await B.snapshot();
  assert.match(after2.snapshot, /Customer name:" \[ref=e\d+\] value="Ada Lovelace"/);
  assert.match(after2.snapshot, /radio "Medium" \[ref=e\d+\] value="medium" checked/);
  assert.match(after2.snapshot, /checkbox "Bacon" \[ref=e\d+\] value="bacon" checked/);
});

test("a submit control is REFUSED without explicit authorisation", async () => {
  await B.navigate(FORM);
  const s = await B.snapshot();
  const submitRef = /button "Submit order" \[ref=(e\d+)\]/.exec(s.snapshot)?.[1];
  assert.ok(submitRef, "submit button not found");
  const r = await B.click(submitRef);
  assert.equal(r.blocked, true);
  assert.equal(r.reason, "submit-confirmation-required");
  // And it must not have navigated.
  const still = await B.snapshot();
  assert.match(still.url, /forms\/post/);
});

test("the same control goes through once authorised", async () => {
  await B.navigate(FORM);
  const s = await B.snapshot();
  const nameRef = /textbox "Customer name:" \[ref=(e\d+)\]/.exec(s.snapshot)?.[1];
  const submitRef = /button "Submit order" \[ref=(e\d+)\]/.exec(s.snapshot)?.[1];
  await B.type(nameRef, "Grace Hopper");
  const r = await B.click(submitRef, { confirmSubmit: true });
  assert.equal(r.blocked, undefined);
  assert.equal(r.submitted, true);
  const body = await B.extract({ format: "text", maxChars: 2000 });
  assert.match(body.content, /Grace Hopper/);
});

test("an ordinary link is not treated as a submission", async () => {
  await B.navigate("https://example.com/");
  const s = await B.snapshot();
  const linkRef = /link "More information[^"]*" \[ref=(e\d+)\]/.exec(s.snapshot)?.[1]
    ?? /link "[^"]*" \[ref=(e\d+)\]/.exec(s.snapshot)?.[1];
  assert.ok(linkRef, "no link found on example.com");
  const r = await B.click(linkRef);
  assert.notEqual(r.blocked, true, "a plain link must not trip the submit gate");
});

test("a stale ref fails with an instruction rather than hitting the wrong element", async () => {
  await B.navigate(FORM);
  await B.snapshot();
  await B.navigate("https://example.com/");
  await assert.rejects(() => B.type("e999", "x"), /fresh browser_snapshot/);
});

test("tabs can be opened, listed and closed", async () => {
  await B.navigate("https://example.com/");
  const opened = await B.newTab("https://example.com/");
  assert.ok(opened.tabs >= 2);
  const list = await B.listTabs();
  assert.equal(list.tabs.filter((t) => t.active).length, 1);
  await B.closeTab(opened.activeTab);
});

test("renderPage returns real HTML for the scraper", async () => {
  const r = await B.renderPage("https://example.com/");
  assert.equal(r.status, 200);
  assert.match(r.html, /<h1>Example Domain<\/h1>/);
});
