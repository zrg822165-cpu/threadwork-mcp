export function normalizeTeamPath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
  return normalized.endsWith("/") && normalized.length > 1 ? normalized.slice(0, -1) : normalized;
}

export function pathsConflict(left: string, right: string): boolean {
  const a = normalizeTeamPath(left);
  const b = normalizeTeamPath(right);
  if (!a || !b) {
    return false;
  }
  if (a === b) {
    return true;
  }
  if (hasGlob(a) || hasGlob(b)) {
    return globConflicts(a, b);
  }
  return isAncestorPath(a, b) || isAncestorPath(b, a);
}

function globConflicts(a: string, b: string): boolean {
  if (hasGlob(a) && !hasGlob(b)) {
    return globToRegExp(a).test(b);
  }
  if (!hasGlob(a) && hasGlob(b)) {
    return globToRegExp(b).test(a);
  }
  const aPrefix = prefixBeforeGlob(a);
  const bPrefix = prefixBeforeGlob(b);
  return aPrefix.startsWith(bPrefix) || bPrefix.startsWith(aPrefix);
}

function hasGlob(value: string): boolean {
  return value.includes("*");
}

function isAncestorPath(parent: string, child: string): boolean {
  return child.startsWith(`${parent}/`);
}

function prefixBeforeGlob(value: string): string {
  return value.slice(0, firstGlobIndex(value)).replace(/[^/]*$/, "");
}

function firstGlobIndex(value: string): number {
  const index = value.indexOf("*");
  return index === -1 ? value.length : index;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .split("**")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}
