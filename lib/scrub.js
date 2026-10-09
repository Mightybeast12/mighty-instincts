// Ports the secret-redaction regex from ECC's hooks/observe.sh (bash) so
// observations never persist a credential just because the shell wrapper
// was swapped for an in-process plugin.
const SECRET_PATTERN =
  /(api[_-]?key|token|secret|password|authorization|credentials?|auth)(["'\s:=]{1,8})((?:bearer|basic|token|bot)\s+)?([A-Za-z0-9_\-/.+=]{8,256})/gi;

export function scrub(text) {
  if (typeof text !== "string") return text;
  return text.replace(SECRET_PATTERN, (_match, label, separator, scheme) => `${label}${separator}${scheme ?? ""}[REDACTED]`);
}

export function clip(text, maxLength) {
  if (typeof text !== "string") return text;
  if (typeof maxLength !== "number" || !Number.isFinite(maxLength)) return text;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}
