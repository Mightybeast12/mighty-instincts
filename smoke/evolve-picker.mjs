// lib/evolve-picker.js: the pure helpers behind the OpenCode 2 TUI's
// /evolve picker. Exercises buildCandidateOptions, buildActionOptions,
// needsConfirm, and commandTextFor directly (no ctx, no filesystem), and
// round-trips commandTextFor's own output back through lib/cli.js's
// tokenizeArgv and lib/evolve-command.js's parseEvolveArgs, the exact
// pipeline the real /evolve command parses a dispatched choice with, so
// a sanitization bug here (reason quoting, in particular) would show up
// as a parse mismatch, not just a string literal that happens to look
// right. Also exercises lib/board-pointer.js's readBoardState, the one
// piece of this picker that does touch the filesystem (shared with
// sidebar.js since Gate 2's shared-helper move).
import fs from "node:fs/promises";
import path from "node:path";
import { tokenizeArgv } from "../lib/cli.js";
import { parseEvolveArgs } from "../lib/evolve-command.js";
import { pointerFilePath, readBoardState } from "../lib/board-pointer.js";
import { buildActionOptions, buildCandidateOptions, commandTextFor, EVOLVE_ACTIONS, needsConfirm, PICKER_CHOICE_TYPES } from "../lib/evolve-picker.js";

export async function run({ assert, makeProjectAndData }) {
  testBuildCandidateOptions(assert);
  testBuildActionOptions(assert);
  testNeedsConfirm(assert);
  testCommandTextForFixedChoices(assert);
  testCommandTextForCandidateChoices(assert);
  testReasonQuotingRoundTrip(assert);
  await testReadBoardState(assert, { makeProjectAndData });
}

// ---------------------------------------------------------------------------
// buildCandidateOptions: an empty/missing proposedList yields only the three
// fixed rows; a populated one adds one row per entry, in order, with the
// documented title/description/footer shape.
// ---------------------------------------------------------------------------
function testBuildCandidateOptions(assert) {
  const fixedTitles = ["Propose from today's clusters (/evolve now)", "Show clusters", "Open the text dashboard"];

  assert.deepEqual(
    buildCandidateOptions(null).map((option) => option.title),
    fixedTitles,
    "a null boardState yields only the three fixed rows",
  );
  assert.deepEqual(
    buildCandidateOptions({}).map((option) => option.title),
    fixedTitles,
    "a boardState with no instincts section yields only the three fixed rows",
  );
  assert.deepEqual(
    buildCandidateOptions({ instincts: { proposedList: [] } }).map((option) => option.title),
    fixedTitles,
    "an empty proposedList yields only the three fixed rows",
  );

  const boardState = {
    instincts: {
      proposedList: [
        { index: 1, id: "a-first", kind: "skill", members: ["d", "e", "f", "g"], summary: "Search before editing." },
        { index: 2, id: "z-second", kind: "rule", members: ["a", "b", "c"], summary: null },
      ],
    },
  };
  const options = buildCandidateOptions(boardState);
  assert.equal(options.length, 5, "two candidates plus the three fixed rows");

  assert.equal(options[0].title, "1 a-first [skill]");
  assert.equal(options[0].description, "Search before editing.");
  assert.equal(options[0].footer, "4 habits");
  assert.deepEqual(options[0].value, { type: PICKER_CHOICE_TYPES.CANDIDATE, id: "a-first", kind: "skill", status: "proposed" });

  assert.equal(options[1].title, "2 z-second [rule]");
  assert.equal(options[1].description, "", "a null summary renders as an empty description, never the literal word null");
  assert.equal(options[1].footer, "3 habits");

  assert.deepEqual(options.slice(2).map((option) => option.title), fixedTitles, "the three fixed rows always come after every candidate row");
  assert.deepEqual(options[2].value, { type: PICKER_CHOICE_TYPES.NOW });
  assert.deepEqual(options[3].value, { type: PICKER_CHOICE_TYPES.CLUSTERS });
  assert.deepEqual(options[4].value, { type: PICKER_CHOICE_TYPES.DASHBOARD });

  const noMembers = buildCandidateOptions({ instincts: { proposedList: [{ index: 1, id: "no-members", kind: "command" }] } });
  assert.equal(noMembers[0].footer, "0 habits", "a candidate entry with no members array at all still renders a footer, as 0 habits");
}

// ---------------------------------------------------------------------------
// buildActionOptions: mixed statuses, matching lib/evolve-command.js's own
// refusals (runInstall/runReject proposed-only, runArchive proposed-or-
// installed, show always available).
// ---------------------------------------------------------------------------
function testBuildActionOptions(assert) {
  const proposed = buildActionOptions({ id: "a", status: "proposed" });
  assert.deepEqual(
    proposed.map((option) => option.value),
    [EVOLVE_ACTIONS.SHOW, EVOLVE_ACTIONS.INSTALL, EVOLVE_ACTIONS.REJECT, EVOLVE_ACTIONS.ARCHIVE],
    "a proposed candidate offers all four actions",
  );

  const installed = buildActionOptions({ id: "b", status: "installed" });
  assert.deepEqual(
    installed.map((option) => option.value),
    [EVOLVE_ACTIONS.SHOW, EVOLVE_ACTIONS.ARCHIVE],
    "an installed candidate offers only show and archive, never install or reject again",
  );

  const archived = buildActionOptions({ id: "c", status: "archived" });
  assert.deepEqual(
    archived.map((option) => option.value),
    [EVOLVE_ACTIONS.SHOW],
    "an archived candidate offers only show; install/reject/archive would all be refused server-side",
  );

  const unknownStatus = buildActionOptions({ id: "d" });
  assert.deepEqual(
    unknownStatus.map((option) => option.value),
    [EVOLVE_ACTIONS.SHOW],
    "a candidate with no status at all is treated the same as archived: show only, never a write/remove action",
  );

  assert.notEqual(installed[1].description, proposed[3].description, "archive's own description differs for an installed candidate (removes a file) vs a proposed one (no file to remove yet)");
}

// ---------------------------------------------------------------------------
// needsConfirm: show never confirms; install/reject/archive always do, each
// with its own message text.
// ---------------------------------------------------------------------------
function testNeedsConfirm(assert) {
  const show = needsConfirm(EVOLVE_ACTIONS.SHOW);
  assert.equal(show.confirm, false);
  assert.equal(show.message, null);

  for (const action of [EVOLVE_ACTIONS.INSTALL, EVOLVE_ACTIONS.REJECT, EVOLVE_ACTIONS.ARCHIVE]) {
    const result = needsConfirm(action);
    assert.equal(result.confirm, true, `${action} needs a confirm dialog`);
    assert.equal(typeof result.message, "string", `${action}'s confirm message is a string`);
    assert.ok(result.message.length > 0, `${action}'s confirm message is non-empty`);
  }

  // Install's own message is pinned exactly (Gate 2's P2-2 fix): it must
  // never promise a write on the very first pick, since
  // lib/evolve-command.js's runInstall only writes once this candidate's
  // body has already been rendered in this same process, and a single
  // /evolve <id> install the first time around only renders and
  // remembers it, the same as a bare detail pick.
  assert.equal(
    needsConfirm(EVOLVE_ACTIONS.INSTALL).message,
    "Shows the detail first; pick Install again to write it.",
    "install's confirm message is honest about the server's two-call look-before-leap gate, never claiming a write on the first pick",
  );

  assert.equal(needsConfirm(undefined).confirm, false, "an unrecognised/missing action never confirms, since there is no write to gate");
  assert.equal(needsConfirm("made-up").confirm, false);
}

// ---------------------------------------------------------------------------
// commandTextFor: the three fixed choices, independent of action/reason.
// ---------------------------------------------------------------------------
function testCommandTextForFixedChoices(assert) {
  assert.equal(commandTextFor({ type: PICKER_CHOICE_TYPES.NOW }), "/evolve now");
  assert.equal(commandTextFor({ type: PICKER_CHOICE_TYPES.CLUSTERS }), "/evolve clusters");
  assert.equal(commandTextFor({ type: PICKER_CHOICE_TYPES.DASHBOARD }), "/evolve");

  // action/reason are ignored entirely for a fixed choice: there is no
  // candidate to apply either one to.
  assert.equal(commandTextFor({ type: PICKER_CHOICE_TYPES.NOW }, EVOLVE_ACTIONS.INSTALL, "ignored"), "/evolve now");
}

// ---------------------------------------------------------------------------
// commandTextFor: a candidate choice, every action, and the id-not-index
// contract (resolvePick's own id lookups never go stale the way a numbered
// index could between this picker's own board-state.json read and the
// user's confirm).
// ---------------------------------------------------------------------------
function testCommandTextForCandidateChoices(assert) {
  const candidate = { type: PICKER_CHOICE_TYPES.CANDIDATE, id: "my-cand", kind: "skill", status: "proposed" };

  assert.equal(commandTextFor(candidate), "/evolve my-cand", "no action at all defaults to the bare detail pick, the one action every status offers");
  assert.equal(commandTextFor(candidate, EVOLVE_ACTIONS.SHOW), "/evolve my-cand");
  assert.equal(commandTextFor(candidate, EVOLVE_ACTIONS.INSTALL), "/evolve my-cand install");
  assert.equal(commandTextFor(candidate, EVOLVE_ACTIONS.ARCHIVE), "/evolve my-cand archive");
  assert.equal(commandTextFor(candidate, EVOLVE_ACTIONS.REJECT), "/evolve my-cand reject", "reject with no reason omits the reason token entirely rather than leaving a trailing space");
  assert.equal(commandTextFor(candidate, EVOLVE_ACTIONS.REJECT, ""), "/evolve my-cand reject", "an empty-string reason is treated the same as no reason");
  assert.equal(commandTextFor(candidate, EVOLVE_ACTIONS.REJECT, "   "), "/evolve my-cand reject", "a whitespace-only reason is also treated as no reason");
  assert.equal(commandTextFor(candidate, EVOLVE_ACTIONS.REJECT, "not useful"), "/evolve my-cand reject not useful");

  assert.equal(commandTextFor({ type: PICKER_CHOICE_TYPES.CANDIDATE }), "/evolve", "a candidate choice missing its own id degrades to the bare dashboard rather than emitting '/evolve undefined'");
}

// ---------------------------------------------------------------------------
// Reason quoting: sanitization matches what lib/cli.js's tokenizeArgv can
// actually round-trip, proven by feeding commandTextFor's own output back
// through tokenizeArgv + parseEvolveArgs (stripping the leading "/evolve "
// the way tui.js's own dispatch does before calling
// ctx.client.session.command, whose own `text` field never includes the
// command name itself).
// ---------------------------------------------------------------------------
function testReasonQuotingRoundTrip(assert) {
  const candidate = { type: PICKER_CHOICE_TYPES.CANDIDATE, id: "quote-cand" };

  function argvTextFor(action, reason) {
    const full = commandTextFor(candidate, action, reason);
    assert.ok(full.startsWith("/evolve"), "every candidate command text still starts with '/evolve'");
    return full.replace(/^\/evolve ?/, "");
  }

  // Plain multi-word reason: round-trips unchanged.
  {
    const parsed = parseEvolveArgs(tokenizeArgv(argvTextFor(EVOLVE_ACTIONS.REJECT, "not useful here")));
    assert.equal(parsed.verb, "reject");
    assert.deepEqual(parsed.pick, { type: "id", value: "quote-cand" });
    assert.equal(parsed.reason, "not useful here");
  }

  // A reason containing a literal double quote: tokenizeArgv has no escape
  // for one (it only toggles a quoted run on and off), so commandTextFor
  // strips it rather than let it silently eat the rest of the text.
  {
    const reason = 'says "lazy" duplicate';
    const text = commandTextFor(candidate, EVOLVE_ACTIONS.REJECT, reason);
    assert.ok(!text.includes('"'), "a reason with a literal double quote has it stripped before the command text is built");
    const parsed = parseEvolveArgs(tokenizeArgv(argvTextFor(EVOLVE_ACTIONS.REJECT, reason)));
    assert.equal(parsed.verb, "reject");
    assert.equal(parsed.reason, "says lazy duplicate", "the reason still reaches parseEvolveArgs intact, minus the quote characters tokenizeArgv could not have carried anyway");
  }

  // Runs of extra whitespace collapse to single spaces, matching what
  // parseEvolveArgs' own tokens.join(\" \") would have produced regardless.
  {
    const reason = "too   many     spaces";
    const parsed = parseEvolveArgs(tokenizeArgv(argvTextFor(EVOLVE_ACTIONS.REJECT, reason)));
    assert.equal(parsed.reason, "too many spaces");
  }

  // A reason that looks like another verb or a pick index: reject's own
  // grammar takes every token after "reject" verbatim as the reason, and
  // commandTextFor relies on that rather than quoting the reason itself.
  {
    const reason = "install 2 archive";
    const parsed = parseEvolveArgs(tokenizeArgv(argvTextFor(EVOLVE_ACTIONS.REJECT, reason)));
    assert.equal(parsed.verb, "reject");
    assert.equal(parsed.reason, "install 2 archive", "a reason that reads like other verbs/picks is still carried through as plain reason text");
  }

  // Non-reject actions round-trip too, confirming the id-based pick (never
  // a 1-based index) resolves back to the exact same id.
  {
    const install = parseEvolveArgs(tokenizeArgv(argvTextFor(EVOLVE_ACTIONS.INSTALL)));
    assert.equal(install.verb, "install");
    assert.deepEqual(install.pick, { type: "id", value: "quote-cand" });

    const archive = parseEvolveArgs(tokenizeArgv(argvTextFor(EVOLVE_ACTIONS.ARCHIVE)));
    assert.equal(archive.verb, "archive");
    assert.deepEqual(archive.pick, { type: "id", value: "quote-cand" });

    const show = parseEvolveArgs(tokenizeArgv(argvTextFor(EVOLVE_ACTIONS.SHOW)));
    assert.equal(show.verb, undefined, "the bare detail pick has no verb at all");
    assert.deepEqual(show.pick, { type: "id", value: "quote-cand" });
  }
}

// ---------------------------------------------------------------------------
// lib/board-pointer.js's readBoardState (Gate 2's shared-helper move: it
// used to be duplicated in tui.js and sidebar.js; now both import this one
// copy). Writes a pointer file plus the board-state.json fixture it names,
// reads them back, and covers the missing-pointer, missing-target, and
// no-resolvable-directory cases, each of which must resolve to null rather
// than throw.
// ---------------------------------------------------------------------------
async function testReadBoardState(assert, { makeProjectAndData }) {
  const { projectDir, dataDir } = makeProjectAndData("evolve-picker-read-board-state");
  const ctx = { location: { directory: projectDir }, options: { dataDir } };

  assert.equal(readBoardState(ctx), null, "no pointer file at all resolves to null, not a thrown error");

  const boardStatePath = path.join(dataDir, "board-state-fixture.json");
  const fixture = {
    updatedAt: "2026-01-01T00:00:00.000Z",
    instincts: { proposedList: [{ index: 1, id: "fixture-cand", kind: "skill", members: ["a"], summary: "s" }] },
  };
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(boardStatePath, JSON.stringify(fixture), "utf8");
  const pointerPath = pointerFilePath({ dataDir }, projectDir);
  await fs.mkdir(path.dirname(pointerPath), { recursive: true });
  await fs.writeFile(pointerPath, JSON.stringify({ boardStatePath }), "utf8");

  assert.deepEqual(readBoardState(ctx), fixture, "a real pointer + board-state.json fixture round-trips exactly");

  await fs.rm(boardStatePath);
  assert.equal(readBoardState(ctx), null, "a pointer naming a missing board-state.json resolves to null, not a thrown error");

  assert.equal(readBoardState({}), null, "a ctx with no resolvable directory at all (no ctx.location, no ctx.data.location.default()) resolves to null");
}
