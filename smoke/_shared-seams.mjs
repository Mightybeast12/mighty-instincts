// Orchestrator seam test: numberCandidates is the one ordering /evolve
// picks and the board hint rows share.
import { numberCandidates } from "../lib/candidates.js";

export async function run({ assert }) {
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
