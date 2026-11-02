import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildSessionDigest,
  formatSessionDigest,
  stageLearningCandidates,
} from "../src/core/session-learning.ts";

const messages = [
  { id: "msg_user", type: "user", text: "We decided to use an outbox." },
  {
    id: "msg_assistant",
    type: "assistant",
    content: [
      { type: "text", text: "The outbox retries deliveries." },
      { type: "reasoning", text: "hidden reasoning" },
      { type: "tool", id: "tool_1", name: "read", state: { input: "tool argument" } },
    ],
  },
  { id: "msg_system", type: "system", text: "system prompt" },
  { id: "msg_secret", type: "user", text: "api_key = abcdefghijklmnop" },
];

test("session digest includes only user and assistant text and redacts secrets", () => {
  const digest = buildSessionDigest(messages, "ses_test", { maxMessages: 10 });
  assert.equal(digest.included, 3);
  assert.match(formatSessionDigest(digest), /We decided to use an outbox/);
  assert.match(formatSessionDigest(digest), /The outbox retries deliveries/);
  assert.doesNotMatch(formatSessionDigest(digest), /hidden reasoning/);
  assert.doesNotMatch(formatSessionDigest(digest), /tool argument/);
  assert.doesNotMatch(formatSessionDigest(digest), /system prompt/);
  assert.doesNotMatch(formatSessionDigest(digest), /abcdefghijklmnop/);
  assert.match(formatSessionDigest(digest), /\[REDACTED\]/);
});

test("session digest enforces message and character budgets", () => {
  const many = Array.from({ length: 10 }, (_, index) => ({
    id: `msg_${index}`,
    type: "user" as const,
    text: `message ${index} `.repeat(50),
  }));
  const digest = buildSessionDigest(many, "ses_budget", {
    maxMessages: 3,
    maxChars: 800,
  });
  assert.equal(digest.included <= 3, true);
  assert.equal(digest.omitted > 0, true);
  assert.equal(digest.truncated, true);
  assert.equal(digest.messages.length, digest.included);
});

test("stageLearningCandidates writes pending review records without touching memory", () => {
  const root = mkdtempSync(path.join(tmpdir(), "goldfish-learn-"));
  try {
    const result = stageLearningCandidates(root, "ses_review", [
      {
        kind: "decision",
        title: "Use an outbox",
        body: "Billing uses an outbox.",
        citations: [
          {
            type: "session",
            locator: "ses_review/msg_1",
            excerpt: "We decided to use an outbox.",
          },
        ],
      },
    ]);
    assert.equal(result.count, 1);
    const lines = readFileSync(result.path, "utf8").trim().split("\n");
    const record = JSON.parse(lines[0]!);
    assert.equal(record.id, "c1");
    assert.equal(record.status, "pending");
    assert.equal(record.sessionID, "ses_review");
    assert.equal(record.citations[0].type, "session");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
