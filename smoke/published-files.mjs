// Every local module a published file imports is published too: a file
// missing from package.json's `files` list installs fine and then breaks
// the plugin at its first import (the sibling guard of mighty-reviewer's
// section 35, 2026-11-12).
import fs from "node:fs";
import path from "node:path";

export async function run({ assert }) {
  const root = new URL("../", import.meta.url);
  const pkg = JSON.parse(fs.readFileSync(new URL("package.json", root), "utf8"));
  const covered = (rel) => pkg.files.some((entry) => (entry.endsWith("/") ? rel.startsWith(entry) : rel === entry));
  const queue = pkg.files.filter((entry) => /\.m?js$/.test(entry));
  for (const entry of pkg.files.filter((e) => e.endsWith("/"))) {
    const dir = new URL(entry, root);
    for (const name of fs.readdirSync(dir, { recursive: true })) {
      if (/\.m?js$/.test(String(name))) queue.push(path.posix.join(entry, String(name).split(path.sep).join("/")));
    }
  }
  const seen = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(new URL(file, root), "utf8");
    for (const [, spec] of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g)) {
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
      assert.ok(covered(rel), `${file} imports ${spec} (${rel}), which package.json's files list must cover`);
      if (/\.m?js$/.test(rel) && fs.existsSync(new URL(rel, root))) queue.push(rel);
    }
  }
  assert.ok(seen.size > 3, `the guard read the published modules: ${seen.size}`);
}
