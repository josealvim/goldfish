function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

/**
 * Small glob matcher for repo-relative scopes.
 *
 * Supports `*` within a path segment, `**` across segments, and `?` for one
 * character. Patterns and values use forward slashes.
 */
export function matchesGlob(pattern: string, value: string): boolean {
  let normalized = pattern.trim().replaceAll("\\", "/");
  const target = value.trim().replaceAll("\\", "/");
  if (!normalized) return false;

  // A trailing slash means "this directory and everything below it".
  if (normalized.endsWith("/")) normalized += "**";

  let source = "";
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index]!;
    if (char === "*") {
      if (normalized[index + 1] === "*") {
        index++;
        if (normalized[index + 1] === "/") {
          index++;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegex(char);
    }
  }

  try {
    return new RegExp(`^${source}$`).test(target);
  } catch {
    return false;
  }
}

export function anyScopeMatches(patterns: readonly string[] | undefined, scopes: readonly string[] | undefined): boolean {
  if (!patterns?.length || !scopes?.length) return false;
  return patterns.some((pattern) => scopes.some((scope) => matchesGlob(pattern, scope)));
}

export function scopeMatchScore(nodeScope: readonly string[], queryScope: readonly string[]): number {
  if (!queryScope.length) return nodeScope.length ? 0.02 : 0.04;
  if (!nodeScope.length) return 0.02;
  return anyScopeMatches(nodeScope, queryScope) ? 0.2 : -0.12;
}

export function displayScope(scope: readonly string[]): string {
  return scope.length ? scope.join(", ") : "global";
}
