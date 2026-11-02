import { createHash } from "node:crypto";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function shortHash(value: string): string {
  return sha256(value).slice(0, 8);
}

export function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.slice(0, 80) || "untitled";
}

export function canonicalKey(kind: string, title: string): string {
  return `${kind}:${slug(title)}`;
}

export function baseNodeId(kind: string, title: string): string {
  return `${kind}/${slug(title)}`;
}

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeBody(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

export function uniqueStrings(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

export function isMaterialChange(
  previous: { title: string; body: string; scope: string[]; citations: Array<{ type: string; locator: string }> },
  next: { title: string; body: string; scope: string[]; citations: Array<{ type: string; locator: string }> },
): boolean {
  if (normalizeText(previous.title) !== normalizeText(next.title)) return true;
  if (normalizeBody(previous.body) !== normalizeBody(next.body)) return true;
  if ([...previous.scope].sort().join("\n") !== [...next.scope].sort().join("\n")) return true;
  const prev = previous.citations.map((citation) => `${citation.type}:${citation.locator}`).sort().join("\n");
  const nextKeys = next.citations.map((citation) => `${citation.type}:${citation.locator}`).sort().join("\n");
  return prev !== nextKeys;
}

export function strongerBasis(a: "verified" | "cited" | "derived" | "inferred", b: "verified" | "cited" | "derived" | "inferred") {
  const rank = { verified: 4, cited: 3, derived: 2, inferred: 1 } as const;
  return rank[a] >= rank[b] ? a : b;
}
