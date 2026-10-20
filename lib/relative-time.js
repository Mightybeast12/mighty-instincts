// Formats the distance between an ISO timestamp and "now" as a short
// duration ("12m", "3d"), with no "ago" / "in" wording of its own so both
// the sidebar panel (sidebar.js) and the /board command's plain-text
// summary (lib/board-format.js) can wrap it with whichever direction word
// fits their sentence, and never drift apart on the underlying math.
const UNITS = [
  { limitSeconds: 60, divisor: 1, suffix: "s" },
  { limitSeconds: 3600, divisor: 60, suffix: "m" },
  { limitSeconds: 86400, divisor: 3600, suffix: "h" },
  { limitSeconds: Infinity, divisor: 86400, suffix: "d" },
];

export function relativeTime(iso, nowMs = Date.now()) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const deltaSeconds = Math.abs(Math.round((nowMs - then) / 1000));
  for (const unit of UNITS) {
    if (deltaSeconds < unit.limitSeconds) {
      const value = Math.max(1, Math.floor(deltaSeconds / unit.divisor));
      return `${value}${unit.suffix}`;
    }
  }
  return `${Math.floor(deltaSeconds / 86400)}d`;
}
