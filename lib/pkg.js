// Single source of truth for this package's plugin id, version, and log
// prefix, so a rename or release bump is one edit instead of a string
// repeated across every module.
import { createRequire } from "node:module";

export const PKG_NAME = "mighty-instincts";

// Read once at module load, straight from package.json, so the sidebar
// header (sidebar.js) can show "Mighty Instincts v<version>" without a
// hardcoded string that would drift from package.json on the next
// release. createRequire (rather than an import assertion) keeps this
// working unchanged under both Node and Bun, since package.json's test
// script runs smoke-test.mjs on both.
export const PKG_VERSION = resolvePkgVersion();

function resolvePkgVersion() {
  try {
    const require = createRequire(import.meta.url);
    return String(require("../package.json").version ?? "");
  } catch {
    return "";
  }
}
