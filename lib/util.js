// Small cross-module helpers with no single natural home among the other
// lib/ files. Centralised here so project.js, cli.js, commands.js, and
// tool.js all format subprocess/parse failures the same way instead of each
// carrying its own copy.
export function describeError(error) {
  if (!error) return "";
  return error instanceof Error ? error.message : String(error);
}
