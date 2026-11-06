// Orchestrator seam tests: the pieces that join lanes together.
import { setup } from "../lib/plugin.js";
import { numberCandidates } from "../lib/candidates.js";
import { resolveProject, siblingInstinctsDir } from "../lib/project.js";
import { writeInstinct } from "../lib/store.js";

export async function run(helpers) {
  await testNumberCandidates(helpers);
  await testPruneAliasForwardsIntoMaintain(helpers);
}

// numberCandidates is the one ordering /evolve picks and the board hint
// rows share.
async function testNumberCandidates({ assert }) {
  const c = (id, status, created) => ({ fields: { id, status, created, kind: "skill", members: [] }, body: "" });
  const numbered = numberCandidates([
    c("b-installed", "installed", "2026-01-02"),
    c("z-proposed", "proposed", "2026-01-03"),
    c("a-proposed", "proposed", "2026-01-03"),
    c("old-proposed", "proposed", "2026-01-01"),
    c("gone", "archived", "2026-01-01"),
  ]);
  assert.deepEqual(
    numbered.map((n) => [n.index, n.candidate.fields.id]),
    [[1, "old-proposed"], [2, "a-proposed"], [3, "z-proposed"], [4, "b-installed"]],
  );
  assert.deepEqual(numberCandidates([]), []);
}

// /instinct-prune is a deprecated alias registered by lib/commands.js that
// forwards into /maintain prune, so the old command keeps deleting stale
// pending instincts through the JS pruneStep, not the Python CLI.
async function testPruneAliasForwardsIntoMaintain({ assert, createPluginHarness, makeProjectAndData }) {
  const { projectDir, dataDir } = makeProjectAndData("prune-alias");
  const options = { python: "/nonexistent/python-never-called", dataDir, board: { enabled: false } };
  const harness = createPluginHarness(projectDir, options);
  const cleanup = await setup(harness.ctx);
  try {
    const project = await resolveProject(harness.ctx, options);
    const pendingDir = siblingInstinctsDir(project, "pending");
    const created = new Date(Date.now() - 40 * 86400000).toISOString();
    await writeInstinct(pendingDir, { id: "stale-pending", trigger: "t", confidence: 0.5, domain: "misc", summary: "s", created }, "# Stale\n");

    const alias = harness.commandDefs.find((def) => def.name === "instinct-prune");
    assert.ok(alias, "/instinct-prune is still registered");
    await alias.execute({ sessionID: "s1", prompt: { text: "--dry-run" } });
    const dryReply = harness.syntheticCalls.at(-1).text;
    assert.ok(dryReply.includes("would"), `dry run previews: ${dryReply}`);

    await alias.execute({ sessionID: "s1", prompt: { text: "" } });
    const reply = harness.syntheticCalls.at(-1).text;
    assert.ok(reply.includes("prune: deleted 1"), `alias ran the JS prune: ${reply}`);
  } finally {
    await cleanup();
  }
}
