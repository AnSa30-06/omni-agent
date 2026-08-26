// Runs after `npm install`. Deliberately does nothing that can fail the install:
// heavy work (browser download, gateway bootstrap) belongs to `omni-agent setup`,
// which can report progress and errors to a user who is watching.
import { ensureDirs } from "../src/util/paths.mjs";

try {
  ensureDirs();
  console.log("omni-agent: data directories ready. Run `omni-agent setup` to finish configuration.");
} catch (err) {
  console.log(`omni-agent: postinstall skipped (${err.message}). Run \`omni-agent setup\` when ready.`);
}
