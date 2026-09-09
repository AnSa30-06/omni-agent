// Runs after `npm install`. Deliberately does nothing that can fail the install:
// heavy work (browser download, gateway bootstrap) belongs to `vireo setup`,
// which can report progress and errors to a user who is watching.
import { ensureDirs } from "../src/util/paths.mjs";

try {
  ensureDirs();
  console.log("vireo: data directories ready. Run `vireo setup` to finish configuration.");
} catch (err) {
  console.log(`vireo: postinstall skipped (${err.message}). Run \`vireo setup\` when ready.`);
}
