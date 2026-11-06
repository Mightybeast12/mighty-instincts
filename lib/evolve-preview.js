// Deterministic preview for the /evolve dispatcher's "clusters" verb
// (lib/evolve-command.js), and for its dashboard's own append-when-
// nothing-is-proposed section. Clusters personal instincts the exact
// same way lib/maintain.js's own evolveStep does (domain, then
// significant-word overlap, see clusterItems/EVOLVE_OVERLAP_THRESHOLD/
// EVOLVE_MIN_CLUSTER_SIZE there, all exported for exactly this), so the
// preview never shows a cluster evolveStep itself would not also form,
// but this module only ever reads instinct files and writes nothing.
//
// Proposing candidates for real now happens through `/evolve now`
// (evolveStep + pruneCandidatesStep, lib/evolve-command.js), never
// through vendor/ecc/instinct-cli.py's own evolve implementation: that
// Python path writes under evolved/skills|commands|agents/, a tree
// lib/candidates.js's loadCandidates never reads, so it is no longer
// reachable from this command at all. This module adds a few facts that
// Python implementation never computed anyway: each cluster's average
// confidence, a deterministic "why" (the significant words its members
// actually share), and a suggested form, now the exact same
// selectCandidateKind (lib/candidates.js) the real lifecycle uses, so
// the preview and the real proposal can never disagree on kind.
import { clusterItems, EVOLVE_MIN_CLUSTER_SIZE, EVOLVE_OVERLAP_THRESHOLD, loadInstinctFiles } from "./maintain.js";
import { selectCandidateKind } from "./candidates.js";
import { significantWords } from "./inject.js";

// How many of a cluster's shared words to name in its "why"; more than a
// handful stops reading as a quick explanation.
const WHY_WORD_LIMIT = 4;

// Exported for lib/evolve-command.js: the /evolve dispatcher's own
// `clusters [N]`/`--limit` parsing, and its dashboard's own cluster
// append, both fall back to this when no limit is given, so the three
// "default to 3" decisions (this module's own formatEvolvePreview
// default, the dispatcher's "clusters" argv fallback, and the
// dispatcher's dashboard append) can never drift apart.
export const DEFAULT_PREVIEW_LIMIT = 3;

function round2(value) {
  return Math.round(value * 100) / 100;
}

function clusterKey(item) {
  return `${item.fields.trigger ?? ""} ${item.fields.summary ?? ""}`;
}

function averageConfidence(cluster) {
  const total = cluster.reduce((sum, item) => sum + (Number(item.fields.confidence) || 0), 0);
  return round2(total / cluster.length);
}

// The significant words shared by at least two cluster members, ranked by
// how many members use them (ties broken alphabetically): a deterministic
// stand-in for "why these were grouped," since clusterItems' own pairwise
// chaining never names the words responsible, and does not guarantee any
// single word is shared by every member at once.
function clusterWhy(cluster) {
  const counts = new Map();
  for (const item of cluster) {
    for (const word of significantWords(clusterKey(item))) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  const shared = [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, WHY_WORD_LIMIT)
    .map(([word]) => word);
  return shared.length > 0 ? shared.join(", ") : "overlapping phrasing (no single word shared by 2 or more members)";
}

// Pure, exported for smoke-test.mjs: the ranked cluster list the preview
// renders from (domain, member ids, size, average confidence, why,
// suggested form), sorted biggest cluster first (ties: higher average
// confidence, then domain name), with no formatting of its own.
export async function buildEvolveClusters(project) {
  const list = await loadInstinctFiles(project.instincts_personal);
  const byDomain = new Map();
  for (const item of list) {
    const domain = (item.fields.domain || "general").toLowerCase();
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push(item);
  }

  const clusters = [];
  for (const [domain, items] of byDomain) {
    for (const cluster of clusterItems(items, EVOLVE_OVERLAP_THRESHOLD, clusterKey)) {
      if (cluster.length < EVOLVE_MIN_CLUSTER_SIZE) continue;
      clusters.push({
        domain,
        memberIds: cluster.map((item) => item.fields.id).sort(),
        size: cluster.length,
        avgConfidence: averageConfidence(cluster),
        why: clusterWhy(cluster),
        form: selectCandidateKind(cluster),
      });
    }
  }

  return clusters.sort((a, b) => b.size - a.size || b.avgConfidence - a.avgConfidence || a.domain.localeCompare(b.domain));
}

// Pure, exported for smoke-test.mjs: renders the top `limit` clusters (0
// means no cap) as the /evolve dispatcher's "clusters" plain-text
// preview, ending with the "run /evolve now" hint. `clusters` is
// whatever buildEvolveClusters (above) returned; this function never
// touches disk itself.
export function formatEvolvePreview(clusters, { limit = DEFAULT_PREVIEW_LIMIT } = {}) {
  if (clusters.length === 0) {
    return `No instinct clusters found yet (need ${EVOLVE_MIN_CLUSTER_SIZE}+ instincts in one domain sharing significant trigger/summary words).`;
  }
  const shown = limit > 0 ? clusters.slice(0, limit) : clusters;
  const lines = [`${shown.length} of ${clusters.length} cluster(s) found:`, ""];
  shown.forEach((cluster, index) => {
    lines.push(
      `${index + 1}. ${cluster.domain} (${cluster.size} members, avg confidence ${Math.round(cluster.avgConfidence * 100)}%, suggested form: ${cluster.form})`,
    );
    lines.push(`   members: ${cluster.memberIds.join(", ")}`);
    lines.push(`   why: shared words ${cluster.why}`);
  });
  lines.push("", "Run /evolve now to propose candidates from these clusters.");
  return lines.join("\n");
}
