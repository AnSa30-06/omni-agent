// Re-measure the keyless model pool and print what has changed since the file.
//
// config/providers/keyless-health.json names the vendors that were measured NOT
// to answer. The app hides their models, so a stale entry silently hides a
// provider that has come back to life - and a missing entry sends a reader onto
// a model that has never worked. Neither shows up on its own, so this script is
// how that file stays true.
//
//   node scripts/check-keyless-health.mjs
//
// ⚠️ It talks to the real upstreams and it is slow on purpose. The gateway
// caches ONE upstream failure and replays it onto that vendor's other models
// for up to ~90 s, so attempts inside a vendor are spaced out; three fast tries
// in a row can all be the same cached failure and condemn a working vendor.
import fs from "node:fs";
import { GatewayClient } from "../src/gateway/client.mjs";
import { pkg } from "../src/util/paths.mjs";

const say = (s = "") => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Vendors that are not part of the keyless pool at all. `openrouter` and
// `no-think` are namespaces over a connection the reader paid for; `auto` is
// the gateway's own routing combo and resolves to something else at call time.
const NOT_KEYLESS = new Set(["openrouter", "auto", "no-think"]);

const MODELS_PER_VENDOR = 5;
const GAP_MS = 25_000;

const doc = JSON.parse(fs.readFileSync(pkg("config", "providers", "keyless-health.json"), "utf8"));
const known = new Map((doc.broken ?? []).map((b) => [b.vendor, b]));

const gc = new GatewayClient();
const all = await gc.listModels();
const byVendor = new Map();
for (const m of all) {
  const vendor = String(m.id).split("/")[0];
  if (NOT_KEYLESS.has(vendor)) continue;
  if (!byVendor.has(vendor)) byVendor.set(vendor, []);
  byVendor.get(vendor).push(m.id);
}

say(`Measuring ${byVendor.size} keyless vendor(s). This takes a few minutes.`);
say("");

const ask = async (id) => {
  try {
    const r = await gc.chat({
      model: id,
      messages: [{ role: "user", content: "Reply with the single word: OK" }],
      // Not 8. A reasoning model can spend a tiny budget thinking and return an
      // empty string, which is not the same thing as a broken provider.
      maxTokens: 64,
      timeoutMs: 90_000,
    });
    const text = String(r.content ?? "").trim();
    return { ok: text.length > 0, note: text.slice(0, 60) || "(empty answer)" };
  } catch (err) {
    return { ok: false, note: String(err.message).replace(/\s+/g, " ").slice(0, 120) };
  }
};

const results = await Promise.all(
  [...byVendor.entries()].map(async ([vendor, ids]) => {
    const tries = [];
    for (const id of ids.slice(0, MODELS_PER_VENDOR)) {
      if (tries.length) await sleep(GAP_MS);
      const r = await ask(id);
      tries.push({ id, ...r });
      if (r.ok) break;
    }
    return { vendor, count: ids.length, works: tries.some((t) => t.ok), tries };
  }),
);

let drift = 0;
for (const r of results.sort((a, b) => Number(a.works) - Number(b.works))) {
  const listed = known.has(r.vendor);
  say(`${r.works ? "WORKS " : "BROKEN"}  ${r.vendor}  (${r.count} models)`);
  for (const t of r.tries) say(`         ${t.ok ? "ok  " : "fail"} ${t.id} :: ${t.note}`);
  if (r.works && listed) {
    drift++;
    say(`   ⚠️  RECOVERED - remove "${r.vendor}" from keyless-health.json, it answers again`);
  }
  if (!r.works && !listed) {
    drift++;
    say(`   ⚠️  NEWLY DEAD - add "${r.vendor}" to keyless-health.json, nothing it serves answers`);
  }
  say("");
}

for (const vendor of known.keys()) {
  if (!byVendor.has(vendor)) {
    say(`note: "${vendor}" is in keyless-health.json but the gateway no longer serves it. Harmless.`);
  }
}

say(drift === 0 ? "keyless-health.json matches what was measured." : `${drift} vendor(s) disagree with keyless-health.json.`);
process.exitCode = drift === 0 ? 0 : 1;
