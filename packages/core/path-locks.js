export function normalizePathPattern(pattern) {
  return String(pattern)
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

export function hasGlob(pattern) {
  return /[*?[\]{}]/.test(pattern);
}

function escapeRegex(value) {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

export function globToRegex(pattern) {
  const normalized = normalizePathPattern(pattern);
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegex(char);
    }
  }
  return new RegExp(`^${source}$`);
}

function staticPrefix(pattern) {
  const normalized = normalizePathPattern(pattern);
  const firstGlob = normalized.search(/[*?[\]{}]/);
  const prefix = firstGlob === -1 ? normalized : normalized.slice(0, firstGlob);
  const slash = prefix.lastIndexOf("/");
  if (slash === -1) return prefix;
  return prefix.slice(0, slash + 1);
}

export function patternsOverlap(left, right) {
  const a = normalizePathPattern(left);
  const b = normalizePathPattern(right);
  if (a === b) return true;

  const aGlob = hasGlob(a);
  const bGlob = hasGlob(b);

  if (aGlob && !bGlob) return globToRegex(a).test(b);
  if (!aGlob && bGlob) return globToRegex(b).test(a);
  if (!aGlob && !bGlob) return false;

  const aPrefix = staticPrefix(a);
  const bPrefix = staticPrefix(b);
  return aPrefix.startsWith(bPrefix) || bPrefix.startsWith(aPrefix);
}
