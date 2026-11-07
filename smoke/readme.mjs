// README.md + docs/*.md consistency: the options JSON block matches a
// real computed merge (not an assumption read off mergeOptions's own
// source), the docs/observer.md, docs/maintenance.md and
// docs/skill-review.md defaults blocks match their own exported
// defaults objects by value, every registered command name is named in
// the README commands section (and nothing else is), README and every
// docs/*.md file name the current package.json version wherever either
// shows one, no file under docs/ or README.md carries an em or en dash,
// and every docs/<name>.md link in the README resolves to a real file
// (and every real file is linked).
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { setup, mergeOptions } from "../lib/plugin.js";
import { OBSERVER_DEFAULTS } from "../lib/observer.js";
import { MAINTENANCE_DEFAULTS } from "../lib/maintain.js";
import { REVIEW_DEFAULTS } from "../lib/review.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const README_PATH = path.join(REPO_ROOT, "README.md");
const DOCS_DIR = path.join(REPO_ROOT, "docs");
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, "package.json");

export async function run(helpers) {
  const readme = await fs.readFile(README_PATH, "utf8");
  const docsFiles = await readDocsFiles();
  await testOptionsBlockMatchesDefaults({ assert: helpers.assert, readme });
  await testCommandNamesMatch({ ...helpers, readme });
  await testVersionStringsMatchPackageJson({ assert: helpers.assert, readme, docsFiles });
  await testNoDashesInReadmeOrDocs({ assert: helpers.assert, readme, docsFiles });
  await testDocsLinksRoundTrip({ assert: helpers.assert, readme, docsFiles });
  await testDocsDefaultsBlocksMatchCode({ assert: helpers.assert, docsFiles });
}

async function readDocsFiles() {
  const entries = await fs.readdir(DOCS_DIR, { withFileTypes: true });
  const names = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => entry.name).sort();
  const files = new Map();
  for (const name of names) files.set(name, await fs.readFile(path.join(DOCS_DIR, name), "utf8"));
  return files;
}

// ---------------------------------------------------------------------------
// (a) The ```json fenced block under "## Options" parses and deep-equals a
// real computed merge, `mergeOptions({})` (exported from lib/plugin.js for
// exactly this reason), rather than an assertion about what that function
// would produce inferred by reading its own source. JSON.stringify already
// drops any undefined-valued key for us (JSON has no way to carry
// `undefined`), so JSON.parse(JSON.stringify(mergeOptions({}))) is the
// exact shape a correct README JSON block must deep-equal. The two keys
// this drops are `dataDir` (default unset) and `observer.model` (default
// unset).
// ---------------------------------------------------------------------------
function extractFencedJsonAfterHeading(content, heading) {
  const headingIndex = content.indexOf(heading);
  if (headingIndex === -1) return null;
  const fenceStart = content.indexOf("```json", headingIndex);
  if (fenceStart === -1) return null;
  const contentStart = content.indexOf("\n", fenceStart) + 1;
  const fenceEnd = content.indexOf("```", contentStart);
  if (fenceEnd === -1) return null;
  return content.slice(contentStart, fenceEnd);
}

// Simpler variant for a doc page that only ever has one ```json fence in
// the whole file: used for the three doc-level defaults blocks below,
// none of which sits directly under a heading of its own.
function extractFirstFencedJson(content) {
  const fenceStart = content.indexOf("```json");
  if (fenceStart === -1) return null;
  const contentStart = content.indexOf("\n", fenceStart) + 1;
  const fenceEnd = content.indexOf("```", contentStart);
  if (fenceEnd === -1) return null;
  return content.slice(contentStart, fenceEnd);
}

function parseJsonOrFail(assert, jsonText, label) {
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    assert.fail(`${label} failed to parse: ${error.message}`);
    return undefined;
  }
}

async function testOptionsBlockMatchesDefaults({ assert, readme }) {
  const jsonText = extractFencedJsonAfterHeading(readme, "## Options");
  assert.ok(jsonText, "README has a ```json fenced block under '## Options'");
  const parsed = parseJsonOrFail(assert, jsonText, "README's Options JSON block");
  if (parsed === undefined) return;

  const computed = JSON.parse(JSON.stringify(mergeOptions({})));
  assert.deepEqual(parsed, computed, "README's Options JSON block must deep-equal mergeOptions({}) (dataDir and observer.model omitted, since JSON cannot carry undefined)");
}

// ---------------------------------------------------------------------------
// docs/observer.md, docs/maintenance.md, and docs/skill-review.md each
// show their own exported defaults object (OBSERVER_DEFAULTS,
// MAINTENANCE_DEFAULTS, REVIEW_DEFAULTS) as one ```json block of its own.
// Only OBSERVER_DEFAULTS carries an undefined-valued key (`model`); the
// other two have none, so their blocks must match with nothing omitted.
// REVIEW_DEFAULTS' `model`/`agent` are `null`, not `undefined`, so JSON
// keeps them as literal `null` rather than dropping them.
// ---------------------------------------------------------------------------
const DOC_DEFAULTS_CHECKS = [
  { file: "observer.md", defaults: OBSERVER_DEFAULTS, exportName: "OBSERVER_DEFAULTS" },
  { file: "maintenance.md", defaults: MAINTENANCE_DEFAULTS, exportName: "MAINTENANCE_DEFAULTS" },
  { file: "skill-review.md", defaults: REVIEW_DEFAULTS, exportName: "REVIEW_DEFAULTS" },
];

async function testDocsDefaultsBlocksMatchCode({ assert, docsFiles }) {
  for (const { file, defaults, exportName } of DOC_DEFAULTS_CHECKS) {
    const content = docsFiles.get(file);
    assert.ok(content, `docs/${file} exists`);
    const jsonText = extractFirstFencedJson(content);
    assert.ok(jsonText, `docs/${file} has a fenced json block`);
    const parsed = parseJsonOrFail(assert, jsonText, `docs/${file}'s defaults JSON block`);
    if (parsed === undefined) continue;

    const computed = JSON.parse(JSON.stringify(defaults));
    assert.deepEqual(parsed, computed, `docs/${file}'s defaults JSON block must deep-equal ${exportName} (undefined-valued keys omitted, since JSON cannot carry undefined; null-valued keys are kept)`);
  }
}

// ---------------------------------------------------------------------------
// (b) Every command name registerCommands actually registers (through
// the same createPluginHarness + setup shape smoke/_shared-seams.mjs
// uses) must be named in the README's commands section, and vice versa:
// nothing in that section should name a command that was never
// registered. A "command name" in the README is the leading
// /word[-word...] token of an inline `` `/...` `` code span, found after
// stripping fenced code blocks (so JSON examples, which never contain a
// bare `/word` inline span, can never be misread as command mentions).
// ---------------------------------------------------------------------------
function extractReadmeCommandNames(content) {
  const withoutFences = content.replace(/```[\s\S]*?```/g, "");
  const names = new Set();
  for (const match of withoutFences.matchAll(/`([^`]+)`/g)) {
    const span = match[1];
    const nameMatch = /^\/([a-z][a-z0-9-]*)/.exec(span);
    if (nameMatch) names.add(nameMatch[1]);
  }
  return names;
}

async function testCommandNamesMatch({ assert, createPluginHarness, makeProjectAndData, readme }) {
  const { projectDir, dataDir } = makeProjectAndData("readme-commands");
  const options = { python: "/nonexistent/python-never-called", dataDir, board: { enabled: false } };
  const harness = createPluginHarness(projectDir, options);
  const cleanup = await setup(harness.ctx);
  let registeredNames;
  try {
    registeredNames = new Set(harness.commandDefs.map((def) => def.name));
  } finally {
    await cleanup();
  }

  const commandsHeadingIndex = readme.indexOf("## Commands");
  assert.ok(commandsHeadingIndex !== -1, "README has a '## Commands' heading");
  const nextHeadingIndex = readme.indexOf("\n## ", commandsHeadingIndex + 1);
  const commandsSection = nextHeadingIndex === -1 ? readme.slice(commandsHeadingIndex) : readme.slice(commandsHeadingIndex, nextHeadingIndex);
  const readmeNames = extractReadmeCommandNames(commandsSection);

  for (const name of registeredNames) {
    assert.ok(readmeNames.has(name), `registered command '/${name}' is not named anywhere in README's Commands section`);
  }
  for (const name of readmeNames) {
    assert.ok(registeredNames.has(name), `README's Commands section names '/${name}', which registerCommands never registers`);
  }
}

// ---------------------------------------------------------------------------
// (c) Wherever README or any docs/*.md file shows a version string
// as the panel header ("Mighty Instincts vX.Y.Z"), it must name the
// current package.json version, and CHANGELOG.md's first entry must be
// Unreleased or that same version, so a release that forgets either is
// caught here.
// ---------------------------------------------------------------------------
async function testVersionStringsMatchPackageJson({ assert, readme, docsFiles }) {
  const pkg = JSON.parse(await fs.readFile(PACKAGE_JSON_PATH, "utf8"));
  const expected = `v${pkg.version}`;
  // Only the panel-header example ("Mighty Instincts vX.Y.Z") means "the
  // installed version"; other vX.Y.Z mentions in the docs are history
  // ("from v0.10.0 and earlier") and must stay as they are.
  const checkOne = (label, content) => {
    for (const match of content.matchAll(/Mighty Instincts (v\d+\.\d+\.\d+)/g)) {
      assert.equal(match[1], expected, `${label} shows the panel header as '${match[1]}', which does not match package.json's current version '${expected}'`);
    }
  };
  checkOne("README.md", readme);
  for (const [name, content] of docsFiles) checkOne(`docs/${name}`, content);

  // CHANGELOG.md's first entry is either the unreleased section or the
  // released version itself (scripts/bump-version.sh renames one into the
  // other during scripts/release.sh).
  const changelog = await fs.readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  const firstHeading = changelog.split("\n").find((line) => line.startsWith("## "));
  assert.ok(
    firstHeading === "## Unreleased" || firstHeading?.startsWith(`## ${expected} (`),
    `CHANGELOG.md's first entry is '${firstHeading}', expected '## Unreleased' or '## ${expected} (<date>)'`,
  );
}

// ---------------------------------------------------------------------------
// (d) No file under docs/ or README.md contains an em dash (U+2014) or
// en dash (U+2013): the release gate (scripts/check.sh's dashes stage)
// refuses them repo-wide, but this smoke test proves the docs set is
// clean on its own, independent of check.sh ever running.
// ---------------------------------------------------------------------------
const DASH_PATTERN = /[\u2013\u2014]/;

async function testNoDashesInReadmeOrDocs({ assert, readme, docsFiles }) {
  assert.ok(!DASH_PATTERN.test(readme), "README.md contains an em dash or en dash");
  assert.ok(docsFiles.size > 0, "docs/ has at least one .md file to check");
  for (const [name, content] of docsFiles) {
    assert.ok(!DASH_PATTERN.test(content), `docs/${name} contains an em dash or en dash`);
  }
}

// ---------------------------------------------------------------------------
// (e) Every `docs/<name>.md` link the README points at must exist, and
// every real file under docs/ must be linked from the README, so a doc
// page can never go un-discoverable or a link can never go stale.
// ---------------------------------------------------------------------------
async function testDocsLinksRoundTrip({ assert, readme, docsFiles }) {
  const linkedNames = new Set([...readme.matchAll(/\]\(docs\/([a-z0-9-]+\.md)\)/g)].map((match) => match[1]));
  assert.ok(linkedNames.size > 0, "README links at least one docs/*.md file");

  const realNames = new Set(docsFiles.keys());
  for (const name of linkedNames) {
    assert.ok(realNames.has(name), `README links docs/${name}, which does not exist`);
  }
  for (const name of realNames) {
    assert.ok(linkedNames.has(name), `docs/${name} exists but is never linked from README`);
  }
}
