// Resolves the root ECC data directory ("homunculus") the same way the
// python CLI's env does (lib/project.js's CLV2_HOMUNCULUS_DIR) and the board
// pointer file does (lib/board-pointer.js). Both the plugin's server half
// and its TUI half need this: the server half uses it to find the shared
// global instincts bucket and to place the pointer file; the TUI half uses
// it to find the pointer file without ever running the python CLI itself.
import os from "node:os";
import path from "node:path";
import { PKG_NAME } from "./pkg.js";

let warnedRelativeDataDir = false;

// A relative dataDir is ambiguous (relative to what?), so it is rejected
// with a warning rather than silently resolved against some arbitrary cwd.
// Returns undefined when no absolute override is configured, which callers
// treat as "use the default location".
export function resolveDataDirOption(options = {}) {
  if (!options.dataDir) return undefined;
  if (!path.isAbsolute(options.dataDir)) {
    if (!warnedRelativeDataDir) {
      warnedRelativeDataDir = true;
      console.warn(`[${PKG_NAME}] dataDir must be absolute, ignoring`);
    }
    return undefined;
  }
  return options.dataDir;
}

// Always returns a concrete directory: the configured override, else
// $XDG_DATA_HOME/ecc-homunculus, else ~/.local/share/ecc-homunculus. This is
// the same fallback chain ECC's own instinct-cli.py uses when
// CLV2_HOMUNCULUS_DIR is unset, kept here so the JS side never disagrees
// with the CLI about where the shared global bucket lives.
export function resolveHomunculusDir(options = {}) {
  const override = resolveDataDirOption(options);
  if (override) return override;
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, "ecc-homunculus");
  return path.join(os.homedir(), ".local", "share", "ecc-homunculus");
}
