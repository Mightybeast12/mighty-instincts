// Resolves project identity by running ECC's own instinct-cli.py
// detect_project() instead of reimplementing its git-remote hashing and
// legacy-path migration in JS. That keeps this plugin and the CLI commands
// in lib/cli.js permanently agreeing on which project a given directory is.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vendor", "ecc", "instinct-cli.py");
const RESOLVE_TIMEOUT_MS = 15000;

// Keyed by ctx.location.directory so two plugin instances (two open
// projects) in the same process never share a cached resolution.
const cache = new Map();

export async function resolveProject(ctx, options = {}) {
  const directory = ctx.location.directory;
  const cached = cache.get(directory);
  if (cached && isStillFresh(cached.info)) return cached.info;

  try {
    const info = await detectProjectViaPython(directory, options);
    cache.set(directory, { info, warned: false });
    return info;
  } catch (error) {
    const previouslyWarned = cached?.warned === true;
    if (!previouslyWarned) {
      console.warn(
        `[opencode-instincts] could not resolve the project via instinct-cli.py (${describeError(error)}); using the global instinct bucket`,
      );
    }
    const info = globalFallback(options);
    cache.set(directory, { info, warned: true });
    return info;
  }
}

export function buildPythonEnv(directory, options = {}) {
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    CLAUDE_PROJECT_DIR: directory,
  };
  // instinct-cli.py resolves its store from XDG_DATA_HOME before falling
  // back to ~/.local/share; dropping it would split the store between the
  // plugin's subprocess and a CLI run from the user's shell.
  if (process.env.XDG_DATA_HOME) env.XDG_DATA_HOME = process.env.XDG_DATA_HOME;
  const dataDir = resolveDataDir(options);
  if (dataDir) env.CLV2_HOMUNCULUS_DIR = dataDir;
  return env;
}

// The project directory moves (projects/<hash>) when a git remote is added
// to a repo that was previously hashed by path (instinct-cli.py:363-379), so
// a cached resolution has to notice its own observations directory
// vanishing underneath it rather than writing into an abandoned folder.
function isStillFresh(info) {
  if (!info?.observations_file) return true;
  try {
    return fs.existsSync(path.dirname(info.observations_file));
  } catch {
    return false;
  }
}

function detectProjectViaPython(directory, options) {
  const loader = buildLoaderScript();
  const env = buildPythonEnv(directory, options);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = execFile(
        options.python ?? "python3",
        ["-c", loader],
        { cwd: directory, env, timeout: RESOLVE_TIMEOUT_MS },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr?.trim() || error.message));
            return;
          }
          try {
            resolve(JSON.parse(stdout));
          } catch (parseError) {
            reject(parseError);
          }
        },
      );
    } catch (error) {
      reject(error);
      return;
    }
    child.stdin?.end();
  });
}

function buildLoaderScript() {
  return [
    "import importlib.util, json",
    `spec = importlib.util.spec_from_file_location("instinct_cli", ${JSON.stringify(CLI_PATH)})`,
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "print(json.dumps(module.detect_project(), default=str))",
  ].join("\n");
}

function resolveDataDir(options) {
  if (!options.dataDir) return undefined;
  return path.isAbsolute(options.dataDir) ? options.dataDir : path.resolve(process.cwd(), options.dataDir);
}

function globalFallback(options) {
  const homunculus = resolveDataDir(options) ?? resolveDefaultHomunculusDir();
  return {
    id: "global",
    name: "global",
    root: "",
    project_dir: homunculus,
    instincts_personal: path.join(homunculus, "instincts", "personal"),
    instincts_inherited: path.join(homunculus, "instincts", "inherited"),
    evolved_dir: path.join(homunculus, "evolved"),
    observations_file: path.join(homunculus, "observations.jsonl"),
  };
}

function resolveDefaultHomunculusDir() {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, "ecc-homunculus");
  return path.join(os.homedir(), ".local", "share", "ecc-homunculus");
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}
