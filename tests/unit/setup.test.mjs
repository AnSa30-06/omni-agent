// The setup wizard's prompt, which had a silent-success failure in it.
import { test } from "node:test";
import assert from "node:assert/strict";
import readline from "node:readline/promises";
import { Readable, Writable } from "node:stream";
import { makeAsk } from "../../src/setup/wizard.mjs";

/** A readline interface over a stdin that is already at end-of-file. */
function eofInterface() {
  const input = Readable.from([]); // ends immediately, exactly like a closed stdin
  const output = new Writable({ write(_c, _e, cb) { cb(); } });
  return readline.createInterface({ input, output });
}

function scriptedInterface(lines) {
  const input = Readable.from(lines.map((l) => l + "\n"));
  const output = new Writable({ write(_c, _e, cb) { cb(); } });
  return readline.createInterface({ input, output });
}

test("a question against an EOF stdin settles instead of hanging forever", async () => {
  // THE BUG: rl.question() on a stdin that is already at EOF neither throws nor
  // resolves - it stays pending, the event loop empties, and Node exits 0. The
  // shipped 1.1.0 build printed its welcome, stopped at the first prompt, and
  // reported success having installed nothing.
  const rl = eofInterface();
  const ask = makeAsk(rl);
  const answered = await Promise.race([
    ask("anything? ", "the-default"),
    new Promise((r) => setTimeout(() => r("NEVER-SETTLED"), 2000)),
  ]);
  assert.notEqual(answered, "NEVER-SETTLED", "the prompt must not hang on a dead stdin");
  assert.equal(answered, "the-default");
  rl.close();
});

test("every later question on a dead stdin also settles, and adds no listeners", async () => {
  // A wizard asks a dozen questions. Attaching a close listener per call leaks
  // them and trips the max-listeners warning.
  const rl = eofInterface();
  const ask = makeAsk(rl);
  await ask("first? ", "a");
  const before = rl.listenerCount("close");
  for (let i = 0; i < 12; i++) {
    assert.equal(await ask(`q${i}? `, `d${i}`), `d${i}`);
  }
  assert.ok(rl.listenerCount("close") <= before, "no listener may be added per question");
  rl.close();
});

test("a real answer still wins, and a bare Enter takes the default", async () => {
  const rl = scriptedInterface(["Yes", ""]);
  const ask = makeAsk(rl);
  assert.equal(await ask("one? ", "dflt"), "Yes");
  assert.equal(await ask("two? ", "dflt"), "dflt");
  rl.close();
});

test("with no interface at all, questions answer with their default", async () => {
  const ask = makeAsk(null);
  assert.equal(await ask("q? ", "d"), "d");
  assert.equal(await ask("q? "), "");
});
