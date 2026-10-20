// Where the TUI half (sidebar.js) finds the project-specific board-state.json
// the server half (lib/board.js) writes.
//
// The state file lives at `<homunculus>/projects/<project-hash>/board-state.json`,
// the same per-project directory as observations.jsonl and
// .observer-state.json. The TUI half knows ctx.location.directory (the real
// filesystem project directory) and ctx.options, but not <project-hash>:
// that comes from ECC's own git-remote hashing (vendor/ecc/instinct-cli.py's
// detect_project(), run via a python subprocess the server half already
// pays for and the TUI half should not need to).
//
// So the server half also writes a tiny pointer file, named only from a
// hash of the real directory path (something both halves already know,
// with no python involved), that holds the state file's absolute path. Both
// halves resolve the pointer file's own location the same way: the ECC data
// directory ("homunculus") given by lib/homunculus-dir.js's default chain.
import crypto from "node:crypto";
import path from "node:path";
import { resolveHomunculusDir } from "./homunculus-dir.js";

export function pointerFilePath(options, directory) {
  const key = crypto
    .createHash("sha256")
    .update(directory ?? "")
    .digest("hex")
    .slice(0, 12);
  return path.join(resolveHomunculusDir(options), `board-pointer-${key}.json`);
}
