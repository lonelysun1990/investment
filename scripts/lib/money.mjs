export function parseMoney(raw) {
  if (typeof raw !== "string") {
    throw new TypeError(`parseMoney expects a string, got ${typeof raw}`);
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new TypeError("parseMoney received an empty string");
  }
  const isNegative = trimmed.startsWith("(") && trimmed.endsWith(")");
  const stripped = trimmed
    .replace(/^\(|\)$/g, "")
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .trim();
  if (!/^-?\d+(\.\d+)?$/.test(stripped)) {
    throw new TypeError(`parseMoney could not parse "${raw}"`);
  }
  const value = Number(stripped);
  return isNegative ? -value : value;
}
