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
import fs from "node:fs";
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

// Reads board-state.json for a TUI-side consumer (sidebar.js's panel,
// tui.js's /evolve picker): resolves the pointer file pointerFilePath()
// above names, keyed off ctx.location.directory (or, when that is unset,
// ctx.data.location.default()), then reads the board-state.json path that
// pointer file names. Synchronous on purpose: two small JSON files, and
// sidebar.js reads it inside a Solid memo once per poll tick. Any failure
// (no pointer yet, a missing board-state.json, malformed JSON) returns
// null rather than throwing: "nothing to show yet" is a state every
// caller already renders.
export function readBoardState(ctx) {
  try {
    const directory = ctx.location?.directory ?? safe(() => ctx.data?.location?.default?.())?.directory;
    if (!directory) return null;
    const pointerPath = pointerFilePath(ctx.options ?? {}, directory);
    const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
    if (!pointer?.boardStatePath) return null;
    return JSON.parse(fs.readFileSync(pointer.boardStatePath, "utf8"));
  } catch {
    return null;
  }
}

function safe(read) {
  try {
    return read();
  } catch {
    return undefined;
  }
}
