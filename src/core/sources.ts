import type { Citation, CitationCheck, CitationSnapshot } from "./types.ts";
import { sha256 } from "./ids.ts";
import {
  containsInstructionLikeText,
  isSensitiveSourcePath,
  redactSecrets,
} from "./safety.ts";

export interface SourceSnapshotOptions {
  windowLines?: number;
  maxSourceBytes?: number;
}

const DEFAULT_WINDOW_LINES = 40;
const DEFAULT_MAX_SOURCE_BYTES = 4_000;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function truncateToBytes(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return { text: value, truncated: false };
  let text = buffer.subarray(0, Math.max(0, maxBytes)).toString("utf8");
  if (text.endsWith("\uFFFD")) text = text.slice(0, -1);
  return { text, truncated: true };
}

function looksBinary(content: Buffer): boolean {
  const sample = content.subarray(0, Math.min(content.length, 8_000));
  return sample.includes(0);
}

function findAnchorLine(lines: string[], excerpt: string | undefined): { line: number; found: boolean } {
  if (!excerpt?.trim()) return { line: 1, found: false };
  const candidates = excerpt
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length >= 4);
  if (!candidates.length) return { line: 1, found: false };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (candidates.some((candidate) => line.includes(candidate))) {
      return { line: index + 1, found: true };
    }
  }
  return { line: 1, found: false };
}

export function buildCitationSnapshot(
  citation: Citation,
  content: Buffer,
  options: SourceSnapshotOptions = {},
): CitationSnapshot {
  const contentHash = sha256(content);
  if (isSensitiveSourcePath(citation.locator)) {
    return {
      locator: citation.locator,
      content: "",
      contentHash,
      lineStart: 0,
      lineEnd: 0,
      truncated: false,
      excerptFound: false,
      redacted: false,
      promptInjectionDetected: false,
      skipReason: "sensitive path",
    };
  }
  if (looksBinary(content)) {
    return {
      locator: citation.locator,
      content: "",
      contentHash,
      lineStart: 0,
      lineEnd: 0,
      truncated: false,
      excerptFound: false,
      redacted: false,
      promptInjectionDetected: false,
      skipReason: "binary file",
    };
  }

  const normalized = content.toString("utf8").replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  const anchor = findAnchorLine(lines, citation.excerpt);
  const windowLines = clamp(
    Math.floor(options.windowLines ?? DEFAULT_WINDOW_LINES),
    5,
    200,
  );
  let lineStart = anchor.found
    ? Math.max(1, anchor.line - Math.floor(windowLines / 2))
    : 1;
  let lineEnd = Math.min(lines.length, lineStart + windowLines - 1);
  if (lineEnd - lineStart + 1 < windowLines) {
    lineStart = Math.max(1, lineEnd - windowLines + 1);
  }
  const window = lines.slice(lineStart - 1, lineEnd).join("\n");
  const cleaned = redactSecrets(window);
  const truncated = truncateToBytes(
    cleaned.text,
    clamp(
      Math.floor(options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES),
      500,
      20_000,
    ),
  );
  return {
    locator: citation.locator,
    content: truncated.text,
    contentHash: sha256(truncated.text),
    lineStart,
    lineEnd,
    truncated: truncated.truncated,
    excerptFound: anchor.found,
    redacted: cleaned.redacted,
    promptInjectionDetected: containsInstructionLikeText(truncated.text),
  };
}

export function capSnapshotBudget(
  checks: CitationCheck[],
  maxSourceBytes: number,
): CitationCheck[] {
  let remaining = Math.max(0, Math.floor(maxSourceBytes));
  return checks.map((check) => {
    const snapshot = check.snapshot;
    if (!snapshot || !snapshot.content) return check;
    const bytes = Buffer.byteLength(snapshot.content, "utf8");
    if (bytes <= remaining) {
      remaining -= bytes;
      return check;
    }
    const truncated = truncateToBytes(snapshot.content, remaining);
    remaining = 0;
    return {
      ...check,
      snapshot: {
        ...snapshot,
        content: truncated.text,
        contentHash: sha256(truncated.text),
        truncated: true,
        skipReason: truncated.text ? snapshot.skipReason : "packet source budget exceeded",
      },
    };
  });
}
