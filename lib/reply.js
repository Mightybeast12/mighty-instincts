// Posting a command's reply back into the session as a synthetic
// message, split into parts when it is long. Kept in its own module so
// every command module (lib/commands.js, lib/commands-instinct.js,
// lib/commands-maintain.js) imports it one way, with no cycle.
import { PKG_NAME } from "./pkg.js";
import { noticeDescription } from "./util.js";

// `resume: true`: a slash command is a direct user action, typed on its
// own turn, and the user is waiting right there for the reply, so it
// should surface immediately rather than sit queued until the next turn.
// lib/observer.js's own synthetic posting (a background run's summary,
// which nobody necessarily typed anything to trigger) keeps `resume: false`
// instead: forcing a resume there would interrupt whatever the session is
// doing on its own schedule, for a message nobody is sitting on.
//
// Long output (most commonly /instinct-status against a project with many
// instincts, or /instinct-projects against many known projects) used to
// be posted as one oversized synthetic message, which the host silently
// cuts off mid-entry rather than rejecting outright. No cap is documented
// for ctx.session.synthetic's own text field, so SYNTHETIC_MESSAGE_CAP is
// a conservative assumption; text under it is posted exactly as before
// (one message, no "(part N of M)" prefix). Text over it is split at
// instinct-cli.py's own entry boundaries (splitForSyntheticMessage below)
// and posted as several consecutive messages instead, each labelled
// "(part N of M)" so a reader can tell the reply continues. Each part's
// chat row (the OpenCode 2 TUI only ever shows a synthetic notice's
// `description`, never its `text`) carries that same part label plus the
// part's own content via noticeDescription, so a long reply is still
// readable without opening the transcript.
export const SYNTHETIC_MESSAGE_CAP = 12000;
// instinct-cli.py's own per-entry confidence bar (`_confidence_bar`,
// e.g. "████████░░") always opens that entry's first line; a blank line
// immediately before one of those (optionally indented) marks a safe
// place to split without ever cutting an entry's own lines apart.
const ENTRY_BOUNDARY = /\n\n(?=[ \t]*[\u2588\u2591]+)/;

// Pure, exported for smoke-test.mjs: splits `text` into the fewest
// messages that each fit within `cap`, cutting only at ENTRY_BOUNDARY
// (never mid-entry). When no such boundary exists at all (plain output
// with no bar-style entries), or a single entry is itself bigger than
// `cap`, that chunk is kept whole rather than cut at an arbitrary
// character offset.
export function splitForSyntheticMessage(text, cap = SYNTHETIC_MESSAGE_CAP) {
  if (typeof text !== "string" || text.length <= cap) return [text];
  const chunks = text.split(ENTRY_BOUNDARY);
  if (chunks.length <= 1) return [text];

  const messages = [];
  let current = chunks[0];
  for (let i = 1; i < chunks.length; i++) {
    const candidate = `${current}\n\n${chunks[i]}`;
    if (candidate.length > cap && current.length > 0) {
      messages.push(current);
      current = chunks[i];
    } else {
      current = candidate;
    }
  }
  messages.push(current);
  return messages;
}

// `cap` is a test seam only (smoke-test.mjs overrides it to exercise
// splitting without needing a many-KB fixture); every real call site uses
// the default SYNTHETIC_MESSAGE_CAP.
export async function postResult(ctx, sessionID, text, cap = SYNTHETIC_MESSAGE_CAP) {
  const parts = splitForSyntheticMessage(text, cap);
  for (let i = 0; i < parts.length; i++) {
    const prefix = parts.length > 1 ? `(part ${i + 1} of ${parts.length})\n` : "";
    try {
      await ctx.session.synthetic({
        sessionID,
        text: `${prefix}\`\`\`\n${parts[i]}\n\`\`\``,
        description: noticeDescription(`${prefix}${parts[i]}`),
        delivery: "queue",
        resume: true,
      });
    } catch (error) {
      console.warn(`[${PKG_NAME}] failed to post command result`, error);
    }
  }
}
