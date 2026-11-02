const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const PRIVATE_KEY_HEADER = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const TOKEN_PATTERNS = [
  /\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{20,})\b/g,
];
const ASSIGNMENT_SECRET =
  /(\b(?:api[_-]?key|secret|password|passwd|access[_-]?token)\s*[:=]\s*['"]?)[^\s'"]{8,}/gi;

export function redactSecrets(value: string): { text: string; redacted: boolean } {
  let text = value.replace(PRIVATE_KEY_BLOCK, "[REDACTED PRIVATE KEY]");
  text = text.replace(PRIVATE_KEY_HEADER, "[REDACTED PRIVATE KEY]");
  for (const pattern of TOKEN_PATTERNS) {
    text = text.replace(pattern, "[REDACTED]");
  }
  text = text.replace(ASSIGNMENT_SECRET, "$1[REDACTED]");
  return { text, redacted: text !== value };
}

export function containsSecret(value: string): boolean {
  return redactSecrets(value).redacted;
}

export function containsInstructionLikeText(value: string): boolean {
  return (
    /\bignore (all )?(previous|prior) instructions\b/i.test(value) ||
    /\bdisregard (the )?(above|previous)\b/i.test(value) ||
    /\byou are now\b/i.test(value) ||
    /\bsystem prompt\b/i.test(value)
  );
}

export function isSensitiveSourcePath(locator: string): boolean {
  const normalized = locator.trim().replaceAll("\\", "/").toLowerCase();
  if (!normalized) return true;
  if (
    /(^|\/)(node_modules|vendor|dist|build|coverage|\.git|\.next|target|out)\//.test(normalized)
  ) {
    return true;
  }
  if (
    /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|bun\.lock|cargo\.lock|poetry\.lock|composer\.lock)$/.test(
      normalized,
    )
  ) {
    return true;
  }
  if (/(^|\/)(\.env(\..*)?|id_rsa|id_ed25519|.*\.pem|.*\.key|.*\.p12|.*\.pfx)$/.test(normalized)) {
    return true;
  }
  if (/(^|\/)(secrets?|credentials?)(\.[^/]*)?$/.test(normalized)) return true;
  if (/(^|\/)(secrets?|credentials?)\//.test(normalized)) return true;
  return false;
}
