// Pure helpers behind the OpenCode 2 TUI's /evolve picker (tui.js): turn
// board-state.json's instincts.proposedList (lib/board.js) into
// ctx.ui.dialog.select() options, turn one chosen candidate into its
// available actions, render a confirmed choice into the exact "/evolve
// ..." text lib/evolve-command.js's grammar accepts, and say whether an
// action needs a confirm dialog first. No filesystem reads and no ctx
// here at all: every function is a plain data transform, so
// smoke/evolve-picker.mjs can exercise the full picker flow without a
// TUI host, and tui.js itself stays a thin wiring layer around these.
//
// A "choice" is whatever ctx.ui.dialog.select<Value>() resolves to from
// buildCandidateOptions' own option list: either one of the three fixed
// values below (no candidate involved, no action step needed) or a
// PICKER_CHOICE_TYPES.CANDIDATE value carrying the one candidate the
// user picked. buildActionOptions and commandTextFor both read that same
// shape, so there is exactly one place (here) that defines it.

export const PICKER_CHOICE_TYPES = Object.freeze({
  CANDIDATE: "candidate",
  NOW: "now",
  CLUSTERS: "clusters",
  DASHBOARD: "dashboard",
});

export const EVOLVE_ACTIONS = Object.freeze({
  SHOW: "show",
  INSTALL: "install",
  REJECT: "reject",
  ARCHIVE: "archive",
});

// ------------------------------------------------------------- step one

// buildCandidateOptions(boardState) -> the picker's first-step select()
// options: one row per entry in instincts.proposedList, in the order
// that array already comes in (lib/board.js's own numberCandidates:
// created asc then id asc, 1-based, proposed candidates only), plus
// three fixed rows for the cases no single candidate row can cover.
// boardState may be null/malformed (lib/board-pointer.js's own
// readBoardState can return null, e.g. before the first board refresh);
// an absent or non-array proposedList just yields the three fixed rows
// alone.
export function buildCandidateOptions(boardState) {
  const proposedList = Array.isArray(boardState?.instincts?.proposedList) ? boardState.instincts.proposedList : [];
  const candidateOptions = proposedList.map((entry) => {
    const memberCount = Array.isArray(entry.members) ? entry.members.length : 0;
    return {
      title: `${entry.index} ${entry.id} [${entry.kind}]`,
      value: { type: PICKER_CHOICE_TYPES.CANDIDATE, id: entry.id, kind: entry.kind, status: "proposed" },
      description: entry.summary ?? "",
      footer: `${memberCount} habits`,
    };
  });
  return [
    ...candidateOptions,
    { title: "Propose from today's clusters (/evolve now)", value: { type: PICKER_CHOICE_TYPES.NOW } },
    { title: "Show clusters", value: { type: PICKER_CHOICE_TYPES.CLUSTERS } },
    { title: "Open the text dashboard", value: { type: PICKER_CHOICE_TYPES.DASHBOARD } },
  ];
}

// ------------------------------------------------------------- step two

// buildActionOptions(candidate) -> the picker's second-step select()
// options, once a PICKER_CHOICE_TYPES.CANDIDATE value has been chosen.
// Mirrors lib/evolve-command.js's own refusals exactly, so an action
// offered here always succeeds server-side: "show" (the bare `/evolve
// <id>` detail) is always offered; "install" and "reject" only when
// `candidate.status` is "proposed" (runInstall/runReject both refuse any
// other status); "archive" whenever it is "proposed" or "installed"
// (runArchive refuses only an already-"archived" one). Every real
// candidate this picker ever shows carries status "proposed" (that is
// all board-state.json's proposedList ever includes), but the check is
// written against the general grammar rather than hardcoded to that one
// status, so it stays correct if a future caller ever passes something
// else through.
export function buildActionOptions(candidate) {
  const status = candidate?.status;
  const options = [{ title: "Show detail", value: EVOLVE_ACTIONS.SHOW, description: "Read the candidate's full drafted body first." }];
  if (status === "proposed") {
    options.push({ title: "Install", value: EVOLVE_ACTIONS.INSTALL, description: "Write it to its target file." });
    options.push({ title: "Reject", value: EVOLVE_ACTIONS.REJECT, description: "Archive it without installing." });
  }
  if (status === "proposed" || status === "installed") {
    options.push({
      title: "Archive",
      value: EVOLVE_ACTIONS.ARCHIVE,
      description: status === "installed" ? "Remove the installed file." : "Archive it without installing.",
    });
  }
  return options;
}

// --------------------------------------------------------------- confirm

// needsConfirm(action) -> whether a chosen action should run through
// ctx.ui.dialog.confirm() before anything is dispatched, and the message
// that confirm dialog should show. "show" is read-only and never needs
// one; install/reject/archive all write or remove something server-side,
// so every one of them does.
//
// Install's own message never promises a write on this exact confirm:
// lib/evolve-command.js's runInstall only writes once this candidate's
// exact body has already been rendered in this same process, and a
// single /evolve <id> install, the first time, only renders and
// remembers it (same as a bare detail pick) rather than writing.
// Chaining a detail call and an install call back to back from here
// was considered and rejected: ctx.client.session.command() is
// documented (the server plugin docs' own Sessions section) to return
// once a request is admitted into the session's inbox, not once a
// command's own execute() has actually finished running, so two
// sequential calls from this file have no documented guarantee of
// running to completion in that same order; see this lane's report for
// the exact passage. Telling the user up front that a first pick only
// shows the detail, and a later one writes it, keeps the server's own
// two-call safety gate intact without this file racing it.
const CONFIRM_MESSAGES = {
  [EVOLVE_ACTIONS.INSTALL]: "Shows the detail first; pick Install again to write it.",
  [EVOLVE_ACTIONS.REJECT]: "Reject this candidate? It is archived with no reason recorded.",
  [EVOLVE_ACTIONS.ARCHIVE]: "Archive this candidate? An installed one also has its file removed.",
};

export function needsConfirm(action) {
  const message = CONFIRM_MESSAGES[action];
  return message ? { confirm: true, message } : { confirm: false, message: null };
}

// ------------------------------------------------------------ dispatch text

// tokenizeArgv (lib/cli.js) toggles into/out of a quoted run on every
// literal '"' and has no escape sequence for one, so a reason carrying a
// double quote would otherwise eat the rest of the text (or worse,
// re-merge with whatever came after a later one); stripped here so the
// reason this produces always round-trips through that same tokenizer
// unchanged. Internal whitespace runs collapse to one space each:
// parseEvolveArgs' own reject branch rejoins its tokens with a single
// `join(" ")`, so a run of several spaces could never have survived that
// trip anyway.
function sanitizeReason(reason) {
  if (typeof reason !== "string") return "";
  return reason.replace(/"/g, "").trim().replace(/\s+/g, " ");
}

// commandTextFor(choice, action, reason) -> the exact "/evolve ..." text
// lib/evolve-command.js's grammar accepts for this choice. `action` and
// `reason` are only read for a PICKER_CHOICE_TYPES.CANDIDATE choice (the
// three fixed choices each have exactly one command text of their own);
// omitting `action` for a candidate choice is read the same as
// EVOLVE_ACTIONS.SHOW (the bare `/evolve <id>` pick), the one action
// that always exists. Candidate ids are matched directly by
// lib/evolve-command.js's own resolvePick (never a 1-based index, which
// can go stale between this picker reading board-state.json and the
// user confirming a choice), so every candidate branch below addresses
// its pick by id.
export function commandTextFor(choice, action, reason) {
  if (choice?.type === PICKER_CHOICE_TYPES.NOW) return "/evolve now";
  if (choice?.type === PICKER_CHOICE_TYPES.CLUSTERS) return "/evolve clusters";
  if (choice?.type === PICKER_CHOICE_TYPES.DASHBOARD) return "/evolve";

  const id = choice?.id;
  if (!id) return "/evolve";
  if (action === EVOLVE_ACTIONS.INSTALL) return `/evolve ${id} install`;
  if (action === EVOLVE_ACTIONS.ARCHIVE) return `/evolve ${id} archive`;
  if (action === EVOLVE_ACTIONS.REJECT) {
    const cleanReason = sanitizeReason(reason);
    return cleanReason ? `/evolve ${id} reject ${cleanReason}` : `/evolve ${id} reject`;
  }
  return `/evolve ${id}`;
}
