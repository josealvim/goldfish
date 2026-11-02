import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CitationInput, NodeKind } from "./types.ts";
import { redactSecrets } from "./safety.ts";

export interface SessionDigestMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  truncated: boolean;
}

export interface SessionDigest {
  sessionID: string;
  generatedAt: string;
  messages: SessionDigestMessage[];
  included: number;
  considered: number;
  skipped: number;
  omitted: number;
  truncated: boolean;
  maxMessages: number;
  maxChars: number;
}

export interface LearningCandidateInput {
  kind: NodeKind;
  title: string;
  body: string;
  citations?: CitationInput[];
}

export interface LearningStageResult {
  path: string;
  count: number;
  sessionID: string;
}

interface MessageLike {
  id?: string;
  type?: string;
  text?: string;
  content?: Array<{ type?: string; text?: string }>;
}

const DEFAULT_MAX_MESSAGES = 40;
const MAX_MESSAGES = 100;
const DEFAULT_MAX_CHARS = 12_000;
const MAX_CHARS = 50_000;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_STAGED_CANDIDATES = 200;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function messageText(message: MessageLike): string | undefined {
  if (message.type === "user") return message.text?.trim();
  if (message.type !== "assistant") return undefined;
  const parts = (message.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text!.trim())
    .filter(Boolean);
  return parts.length ? parts.join("\n") : undefined;
}

function truncateText(value: string, max: number): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  return { text: `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`, truncated: true };
}

export function buildSessionDigest(
  messages: unknown[],
  sessionID: string,
  options: { maxMessages?: number; maxChars?: number } = {},
): SessionDigest {
  const maxMessages = clamp(
    Math.floor(options.maxMessages ?? DEFAULT_MAX_MESSAGES),
    1,
    MAX_MESSAGES,
  );
  const maxChars = clamp(
    Math.floor(options.maxChars ?? DEFAULT_MAX_CHARS),
    500,
    MAX_CHARS,
  );
  const eligible: Array<{ id: string; role: "user" | "assistant"; text: string }> = [];
  let skipped = 0;

  messages.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") {
      skipped++;
      return;
    }
    const message = raw as MessageLike;
    const text = messageText(message);
    if (!text) {
      skipped++;
      return;
    }
    const redacted = redactSecrets(text);
    eligible.push({
      id: String(message.id ?? `message-${index + 1}`),
      role: message.type === "user" ? "user" : "assistant",
      text: redacted.text,
    });
  });

  const omittedByCount = Math.max(0, eligible.length - maxMessages);
  const selected = eligible.slice(-maxMessages);
  const digestMessages: SessionDigestMessage[] = [];
  let chars = 0;
  let omittedByBudget = 0;
  let truncated = false;

  for (let index = 0; index < selected.length; index++) {
    const message = selected[index]!;
    const remaining = maxChars - chars;
    if (remaining <= 0) {
      omittedByBudget = selected.length - index;
      truncated = true;
      break;
    }
    const bounded = truncateText(
      message.text,
      Math.min(MAX_MESSAGE_CHARS, remaining),
    );
    if (!bounded.text) {
      omittedByBudget = selected.length - index;
      truncated = true;
      break;
    }
    if (bounded.truncated) truncated = true;
    digestMessages.push({
      id: message.id,
      role: message.role,
      text: bounded.text,
      truncated: bounded.truncated,
    });
    chars += bounded.text.length;
  }

  return {
    sessionID,
    generatedAt: new Date().toISOString(),
    messages: digestMessages,
    included: digestMessages.length,
    considered: eligible.length,
    skipped,
    omitted: omittedByCount + omittedByBudget,
    truncated: truncated || omittedByCount > 0,
    maxMessages,
    maxChars,
  };
}

export function formatSessionDigest(digest: SessionDigest): string {
  const lines = [
    `# Session digest`,
    `Session: ${digest.sessionID}`,
    `Generated: ${digest.generatedAt}`,
    `Messages: ${digest.included} included · ${digest.considered} considered · ${digest.skipped} skipped · ${digest.omitted} omitted`,
    `Budget: ${digest.maxMessages} messages · ${digest.maxChars} chars${digest.truncated ? " · truncated" : ""}`,
    "",
  ];
  if (!digest.messages.length) {
    lines.push("No user or assistant text was available.");
  } else {
    for (const message of digest.messages) {
      lines.push(
        `## ${message.id} [${message.role}]${message.truncated ? " (excerpt)" : ""}`,
        message.text,
        "",
      );
    }
  }
  lines.push(
    "This digest is evidence of what was said, not proof that it is true.",
    "Use only user and assistant text; do not infer from omitted tool content.",
  );
  return lines.join("\n").trimEnd();
}

function safeSessionID(sessionID: string): string {
  const cleaned = sessionID.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return cleaned || "unknown-session";
}

function sanitizeCandidate(candidate: LearningCandidateInput): LearningCandidateInput {
  return {
    kind: candidate.kind,
    title: redactSecrets(candidate.title).text.slice(0, 300),
    body: redactSecrets(candidate.body).text.slice(0, 2_000),
    ...(candidate.citations?.length
      ? {
          citations: candidate.citations.map((citation) => ({
            ...citation,
            ...(citation.excerpt
              ? { excerpt: redactSecrets(citation.excerpt).text.slice(0, 500) }
              : {}),
          })),
        }
      : {}),
  };
}

export function stageLearningCandidates(
  projectRoot: string,
  sessionID: string,
  candidates: LearningCandidateInput[],
): LearningStageResult {
  const directory = path.join(projectRoot, ".opencode", "memory", "session-learning");
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${safeSessionID(sessionID)}.jsonl`);
  const now = new Date().toISOString();
  const records = candidates.slice(0, MAX_STAGED_CANDIDATES).map((candidate, index) => {
    const sanitized = sanitizeCandidate(candidate);
    return JSON.stringify({
      id: `c${index + 1}`,
      sessionID,
      status: "pending",
      createdAt: now,
      ...sanitized,
    });
  });
  writeFileSync(file, records.length ? `${records.join("\n")}\n` : "");
  return { path: file, count: records.length, sessionID };
}
