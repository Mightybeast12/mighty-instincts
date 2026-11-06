/**
 * OpenCode 2 TUI companion for mighty-instincts.
 *
 * Mounts two independent, feature-detected pieces:
 *
 * - The sidebar board panel (sidebar.js), when the host offers slots.
 *   That module imports the host's @opentui/solid and solid-js, so it is
 *   loaded lazily and a failure there never breaks plugin setup.
 * - The /evolve picker (mountEvolvePicker below): typing /evolve with no
 *   arguments opens a pick-a-candidate / pick-an-action / confirm flow
 *   instead of the server's text dashboard, so a human never types an
 *   id or a 1-based index by hand. Every write still happens in the
 *   server's own /evolve command (lib/evolve-command.js) with its own
 *   gates (install's look-before-leap, archive's ownership checks,
 *   reject's status refusal); this file only ever assembles the exact
 *   "/evolve ..." text that command already accepts
 *   (lib/evolve-picker.js's commandTextFor) and dispatches it through
 *   ctx.client.session.command(), the same call a typed slash command
 *   itself resolves to. Needs ctx.keymap.layer and
 *   ctx.ui.dialog.select, both only ever reached after an explicit
 *   feature-detect (mountEvolvePicker's own early returns); when either
 *   is missing, nothing here runs at all, and typing /evolve still
 *   reaches the server's own dashboard exactly as before.
 */
import { readBoardState } from "./lib/board-pointer.js";
import { buildActionOptions, buildCandidateOptions, commandTextFor, EVOLVE_ACTIONS, needsConfirm, PICKER_CHOICE_TYPES } from "./lib/evolve-picker.js";
import { PKG_NAME } from "./lib/pkg.js";

const plugin = {
  id: PKG_NAME,
  async setup(ctx) {
    const disposeSidebar = await mountSidebar(ctx);
    const disposeEvolvePicker = await mountEvolvePicker(ctx);
    return async () => {
      disposeSidebar?.();
      disposeEvolvePicker?.();
    };
  },
};

async function mountSidebar(ctx) {
  if (ctx.options?.board?.enabled === false) return undefined;
  if (typeof ctx.ui?.slot !== "function") return undefined;
  try {
    const sidebar = await import("./sidebar.js");
    return sidebar.mountSidebar(ctx);
  } catch (error) {
    console.error(`[${PKG_NAME}] sidebar panel unavailable`, error);
    return undefined;
  }
}

// ------------------------------------------------------------ evolve picker

// Registers the /evolve slash command (plus its command-palette entry)
// through a reactive keymap layer, the same pattern the plugin CLI docs'
// own "Slots" and "Keymaps" sections describe and
// github.com/0xkuze/add-dir-opencode's v2-tui.ts uses: layer() must run
// inside a mounted component (it throws "Keymap.Provider is missing"
// called directly from setup), so this claims a render-nothing "app"
// slot purely to give the layer a Solid owner. Feature-detected on
// ctx.keymap?.layer, ctx.ui?.dialog?.select, and ctx.ui?.slot: any one
// missing (an older host, or a non-TUI smoke/test ctx) and this mounts
// nothing, leaving the server's own /evolve dashboard untouched.
async function mountEvolvePicker(ctx) {
  if (typeof ctx.keymap?.layer !== "function") return undefined;
  if (typeof ctx.ui?.dialog?.select !== "function") return undefined;
  if (typeof ctx.ui?.slot !== "function") return undefined;
  try {
    return ctx.ui.slot({
      append: "app",
      render: () => {
        try {
          ctx.keymap.layer(() => ({
            mode: "global",
            commands: [
              {
                id: `${PKG_NAME}.evolve-picker`,
                title: "Evolve: pick a candidate",
                description: "Pick an evolve candidate and an action without typing an id or a number.",
                palette: true,
                slash: { name: "evolve", arguments: true },
                run: (input) => runEvolveSlash(ctx, input),
              },
            ],
          }));
        } catch (error) {
          console.error(`[${PKG_NAME}] evolve picker layer unavailable`, error);
        }
        return null;
      },
    });
  } catch (error) {
    console.error(`[${PKG_NAME}] evolve picker slot unavailable`, error);
    return undefined;
  }
}

// The slash command's own run(input): with a non-empty input (e.g. a
// human typed "/evolve 2 install" rather than the bare command), that
// text is forwarded unchanged to the server's /evolve command, so
// nothing about this layer registering the same slash name ever changes
// what a fully-typed command does. An empty input runs the picker flow
// instead.
async function runEvolveSlash(ctx, input) {
  try {
    const sessionID = currentSessionID(ctx);
    if (!sessionID) {
      safeToast(ctx, "error", "Open a session before running /evolve.");
      return;
    }
    const text = normalizeSlashInput(input);
    if (text.length > 0) {
      await dispatchEvolve(ctx, sessionID, text);
      return;
    }
    await runEvolvePicker(ctx, sessionID);
  } catch (error) {
    console.error(`[${PKG_NAME}] /evolve picker failed`, error);
    safeToast(ctx, "error", "The /evolve picker failed; see the log.");
  }
}

// `slash: { arguments: true }`'s own contract (the CLI plugin docs'
// "Slash commands and palette entries" section: "the typed argument
// string is passed to run(input)") should already exclude the leading
// "/evolve" token itself, the same way lib/commands.js's own
// `prompt.text` does for the server-registered command of the same
// name. Normalized defensively anyway, with the exact same stripping
// argvTextFromCommandText uses below, in case a host build or another
// dispatch path (e.g. a programmatic ctx.keymap.dispatch(id, input))
// ever hands this the full raw composer text instead: in the expected
// case the regex simply finds nothing at the very start and leaves the
// text untouched, including a reason that happens to mention "/evolve"
// somewhere other than its own first token.
function normalizeSlashInput(input) {
  const raw = typeof input === "string" ? input.trim() : "";
  return argvTextFromCommandText(raw).trim();
}

// Pick a candidate (or one of the three fixed rows), then, for a real
// candidate, pick an action and confirm it when lib/evolve-picker.js's
// needsConfirm says to. Cancelling either select (Escape resolves
// undefined, per the CLI plugin docs' own Dialogs section) or declining
// the confirm ends the flow with nothing dispatched.
async function runEvolvePicker(ctx, sessionID) {
  const boardState = readBoardState(ctx);
  const choice = await ctx.ui.dialog.select({
    title: "Evolve",
    placeholder: "Pick a candidate or action",
    options: buildCandidateOptions(boardState),
  });
  if (choice === undefined) return;

  if (choice.type !== PICKER_CHOICE_TYPES.CANDIDATE) {
    await dispatchChoice(ctx, sessionID, choice);
    return;
  }

  const action = await ctx.ui.dialog.select({
    title: `Evolve: ${choice.id}`,
    placeholder: "Pick an action",
    options: buildActionOptions(choice),
  });
  if (action === undefined) return;

  if (action !== EVOLVE_ACTIONS.SHOW) {
    const { confirm, message } = needsConfirm(action);
    if (confirm && typeof ctx.ui.dialog.confirm === "function") {
      const confirmed = await ctx.ui.dialog.confirm({ title: "Evolve", message });
      if (!confirmed) return;
    }
  }

  await dispatchChoice(ctx, sessionID, choice, action);
}

// Dispatches the chosen candidate/action pair and toasts the result.
//
// Install is the one action with a two-call server-side gate
// (lib/evolve-command.js's runInstall): a write only ever happens once
// this exact candidate body has already been rendered in this same
// process; the first /evolve <id> install for a given body only renders
// and remembers it (runInstall's own "not yet armed" branch returns the
// detail plus "run ... install again", the same detail text a bare
// /evolve <id> pick would have rendered), and only a later call that
// finds it already remembered actually writes. Whether a single
// dispatchChoice call here lands on the arming half or the writing half
// cannot be told from this side, so the toast never claims "Ran" for
// install (lib/evolve-picker.js's own needsConfirm message already told
// the user up front that a first pick only shows the detail and a later
// one writes it); every other action here has no such ambiguity, so its
// toast still names the exact command that ran.
async function dispatchChoice(ctx, sessionID, choice, action) {
  const commandText = commandTextFor(choice, action);
  await dispatchEvolve(ctx, sessionID, argvTextFromCommandText(commandText));
  safeToast(ctx, "success", action === EVOLVE_ACTIONS.INSTALL ? "Sent" : `Ran ${commandText}`);
}

// Strips commandTextFor's own leading "/evolve" (and the single space
// after it, when there is more to follow): ctx.client.session.command()'s
// own input shape (@opencode/client's SessionCommandInput: { sessionID,
// name, text }) carries the command name and its argv text as two
// separate fields, so "/evolve" itself is never part of `text`.
function argvTextFromCommandText(commandText) {
  return commandText.replace(/^\/evolve ?/, "");
}

// ctx.client (the @opencode/client instance every TUI plugin gets) exposes
// session.command(input: SessionCommandInput): Promise<void>, where
// SessionCommandInput is `{ sessionID, name, text, files?, agents?,
// skills?, delivery? }` (@opencode/client 2.2.5's generated/types.d.ts).
// This is the exact call a host resolves a typed "/evolve ..." slash
// command to once it picks the registered command named "evolve" (see
// lib/commands.js's buildEvolveCommand, which reads `prompt.text` as this
// same argv text); calling it directly here means a programmatic dispatch
// from this picker behaves identically to the user having typed it,
// regardless of how the host resolves a slash name that both a server
// command and a TUI keymap layer register (see this lane's report for
// what could and could not be confirmed about that precedence).
async function dispatchEvolve(ctx, sessionID, argvText) {
  await ctx.client.session.command({ sessionID, name: "evolve", text: argvText });
}

// The current route (@opencode/plugin/tui's UI.router.current(): `{ type:
// "home" } | { type: "session", sessionID } | { type: "plugin", ... }`).
// An "app" slot is not session-scoped the way sidebar.content is (its own
// render props carry no sessionID at all), so this is the one surface a
// global keymap layer has for "which session, if any, is the user looking
// at right now".
function currentSessionID(ctx) {
  try {
    const route = ctx.ui?.router?.current?.();
    return route?.type === "session" ? route.sessionID : null;
  } catch {
    return null;
  }
}

function safeToast(ctx, variant, message) {
  try {
    ctx.ui?.toast?.show?.({ variant, message });
  } catch {
    // Best-effort only: a broken toast surface should never crash the
    // picker flow on top of whatever already went wrong.
  }
}

export default plugin;
