// Small cross-module helpers with no single natural home among the other
// lib/ files. Centralised here so project.js, cli.js, commands.js, and
// tool.js all format subprocess/parse failures the same way instead of each
// carrying its own copy.
import { PKG_NAME } from "./pkg.js";

export function describeError(error) {
  if (!error) return "";
  return error instanceof Error ? error.message : String(error);
}

/**
 * The OpenCode 2 TUI renders a `ctx.session.synthetic` inbox item as a
 * single chat row, "\u25c8 <description>" (SessionNoticeMessageV2), and
 * never shows the item's `text` at all. So every synthetic notice this
 * plugin posts needs its real content in `description`, not just the
 * package name: `description` carries what the user reads in the
 * transcript, `text` carries what the model reads on its next turn. The
 * `maxLines` cap keeps a long command result (status dumps, project
 * listings) from flooding the chat row with dozens of lines; the model
 * still gets the untouched, uncapped `text`.
 *
 * Normalises `text` to a string, drops trailing blank lines, and returns
 * `"<PKG_NAME> \u00b7 <first line>"` when at most one line remains.
 * Otherwise returns that same lead line followed by the remaining lines,
 * each indented by two spaces, kept up to `maxLines` lines in total
 * (the lead line counts as one); when lines had to be dropped to fit, a
 * final "  +<dropped> more lines" line is appended. Empty text returns
 * just PKG_NAME.
 */
export function noticeDescription(text, maxLines = 20) {
  const lines = String(text ?? "").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return PKG_NAME;
  if (lines.length === 1) return `${PKG_NAME} \u00b7 ${lines[0]}`;
  const kept = lines.slice(0, maxLines);
  const dropped = lines.length - kept.length;
  const body = kept.slice(1).map((line) => `  ${line}`);
  if (dropped > 0) body.push(`  +${dropped} more lines`);
  return `${PKG_NAME} \u00b7 ${kept[0]}\n${body.join("\n")}`;
}
