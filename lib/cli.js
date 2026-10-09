// Sole gateway to vendor/ecc/instinct-cli.py. Every call goes through argv
// and env allowlists here so lib/commands.js (full access) and lib/tool.js
// (read-only) cannot drift into exposing a flag or subcommand this port
// deliberately cut (see .slim/deepwork/port.md F1, F5, F9).
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPythonEnv } from "./project.js";

const CLI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vendor", "ecc", "instinct-cli.py");
const CLI_TIMEOUT_MS = 60000;
const CLI_MAX_BUFFER = 1024 * 1024;
const OUTPUT_CLIP_CHARS = 8000;

const FLAG_ALLOWLIST = {
  status: [],
  import: ["--dry-run", "--force", "--min-confidence", "--scope"],
  export: ["--output", "--domain", "--min-confidence", "--scope"],
  evolve: ["--generate", "--limit"],
  promote: ["--dry-run", "--force"],
  projects: [],
  prune: ["--dry-run", "--max-age"],
};

// instinct-cli.py's `projects` command only turns destructive (delete,
// merge, gc) through positional subcommand arguments, and this wrapper
// never exposes those (port.md F9), so every action's positional budget is
// just whatever a non-destructive argparse subparser declares.
const POSITIONAL_LIMITS = {
  status: 0,
  import: 1,
  export: 0,
  evolve: 0,
  promote: 1,
  projects: 0,
  prune: 0,
};

const VALUE_FLAGS = new Set(["--min-confidence", "--scope", "--output", "--domain", "--limit", "--max-age"]);

export function tokenizeArgv(input) {
  if (!input) return [];
  const tokens = [];
  let current = "";
  let inQuotes = false;
  for (const ch of input) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

export async function runCli(project, options, action, argv, { force = false, directory } = {}) {
  if (!Object.hasOwn(FLAG_ALLOWLIST, action)) {
    return `Unknown instincts action: ${action}`;
  }

  const tokens = Array.isArray(argv) ? argv.slice() : tokenizeArgv(argv ?? "");

  const flagError = checkFlags(action, tokens);
  if (flagError) return flagError;

  const positionalError = checkPositionals(action, tokens);
  if (positionalError) return positionalError;

  if (directory) {
    const pathError = await checkPathContainment(directory, action, tokens);
    if (pathError) return pathError;
  }

  const finalArgv = tokens.slice();
  if (force && FLAG_ALLOWLIST[action].includes("--force") && !finalArgv.includes("--force")) {
    finalArgv.push("--force");
  }

  const cwd = directory ?? process.cwd();
  const env = buildPythonEnv(cwd, options ?? {});

  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(
        options?.python ?? "python3",
        [CLI_PATH, action, ...finalArgv],
        { cwd, env, timeout: CLI_TIMEOUT_MS, maxBuffer: CLI_MAX_BUFFER },
        (error, stdout, stderr) => {
          const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
          resolve(clipOutput(combined || describeError(error)));
        },
      );
    } catch (error) {
      resolve(`Failed to launch instinct-cli.py: ${describeError(error)}`);
      return;
    }
    // execFile has no option to start the child with stdin already closed,
    // so any residual input() call in the CLI (confirmation prompts we
    // intentionally bypass with --force) must get an immediate EOF instead
    // of hanging on an open pipe nobody will ever write to.
    child.stdin?.end();
  });
}

function checkFlags(action, tokens) {
  const allowed = new Set(FLAG_ALLOWLIST[action]);
  for (const token of tokens) {
    if (token.startsWith("--") && !allowed.has(token)) {
      return `Flag not permitted for '${action}': ${token}`;
    }
  }
  return null;
}

function checkPositionals(action, tokens) {
  const limit = POSITIONAL_LIMITS[action] ?? 0;
  let count = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("--")) {
      if (VALUE_FLAGS.has(token)) i += 1;
      continue;
    }
    count += 1;
  }
  return count > limit ? `Too many positional arguments for '${action}' (max ${limit}).` : null;
}

async function checkPathContainment(directory, action, tokens) {
  if (action === "import") {
    const source = firstPositional(tokens);
    if (source && !/^https?:\/\//i.test(source)) {
      return containmentError(directory, source, { mayNotExist: false });
    }
  }
  if (action === "export") {
    const value = flagValue(tokens, "--output");
    if (value) return containmentError(directory, value, { mayNotExist: true });
  }
  return null;
}

function firstPositional(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("--")) {
      if (VALUE_FLAGS.has(token)) i += 1;
      continue;
    }
    return token;
  }
  return undefined;
}

function flagValue(tokens, flag) {
  const idx = tokens.indexOf(flag);
  if (idx === -1 || idx + 1 >= tokens.length) return undefined;
  return tokens[idx + 1];
}

async function containmentError(directory, targetPath, { mayNotExist }) {
  try {
    const base = await fs.realpath(directory);
    const resolved = path.resolve(directory, targetPath);
    const real = mayNotExist
      ? path.join(await fs.realpath(path.dirname(resolved)), path.basename(resolved))
      : await fs.realpath(resolved);
    const rel = path.relative(base, real);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return null;
    return `Path escapes the project directory: ${targetPath}`;
  } catch (error) {
    return `Invalid path '${targetPath}': ${describeError(error)}`;
  }
}

function clipOutput(text) {
  return text.length > OUTPUT_CLIP_CHARS ? text.slice(0, OUTPUT_CLIP_CHARS) : text;
}

function describeError(error) {
  if (!error) return "";
  return error instanceof Error ? error.message : String(error);
}
