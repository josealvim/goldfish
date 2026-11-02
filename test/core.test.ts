import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/core/store.ts";

async function withStore(callback: (store: MemoryStore, root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "goldfish-"));
  mkdirSync(path.join(root, "docs"), { recursive: true });
  writeFileSync(path.join(root, "docs", "decisions.md"), "# Decisions\n\nUse SQLite for local project memory.\n");
  const store = await MemoryStore.open({ dbPath: ":memory:", projectRoot: root });
  try {
    await callback(store, root);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const author = { type: "system" as const, id: "test" };

test("remember creates a cited node and recall finds it", async () => {
  await withStore((store) => {
    const result = store.remember(
      {
        kind: "decision",
        title: "Use SQLite for project memory",
        body: "SQLite with FTS5 keeps project memory local and fast.",
        scope: ["src/core/**"],
        citations: [{ type: "file", locator: "docs/decisions.md", excerpt: "Use SQLite" }],
      },
      { author },
    );
    assert.equal(result.action, "created");
    assert.equal(result.node?.basis, "cited");
    assert.equal(result.node?.autoInjectEligible, true);

    const recalled = store.recall({ query: "SQLite project memory" });
    assert.equal(recalled.cards.length, 1);
    assert.equal(recalled.cards[0]?.id, result.node?.id);
    assert.equal(recalled.cards[0]?.citations.length, 1);
  });
});

test("duplicate claims merge citations instead of creating duplicates", async () => {
  await withStore((store) => {
    const proposal = {
      kind: "decision" as const,
      title: "Use SQLite for project memory",
      body: "SQLite with FTS5 keeps project memory local and fast.",
      citations: [
        {
          type: "file" as const,
          locator: "docs/decisions.md",
          excerpt: "Use SQLite",
          metadata: { lineStart: 1 },
        },
      ],
    };
    const first = store.remember(proposal, { author });
    const second = store.remember(
      {
        ...proposal,
        citations: [
          {
            type: "file",
            locator: "docs/decisions.md",
            excerpt: "local and fast",
            metadata: { lineStart: 2 },
          },
        ],
      },
      { author },
    );
    assert.equal(first.action, "created");
    assert.equal(second.action, "merged");
    assert.equal(store.get(first.node!.id)?.citations.length, 2);
  });
});

test("inferred claims require confirmation before auto-injection", async () => {
  await withStore((store) => {
    const result = store.remember(
      {
        kind: "gotcha",
        title: "Retry key may be missing",
        body: "The billing worker can duplicate charges when the retry key is absent.",
        basis: "inferred",
      },
      { author },
    );
    assert.equal(result.node?.basis, "inferred");
    assert.equal(result.node?.autoInjectEligible, false);

    const injected = store.recall({
      query: "billing retry key",
      autoInjectOnly: true,
    });
    assert.equal(injected.cards.length, 0);

    const explicit = store.recall({ query: "billing retry key" });
    assert.equal(explicit.cards.length, 1);
    assert.equal(explicit.cards[0]?.basis, "inferred");

    const confirmed = store.confirm(result.node!.id, {
      as: "verified",
      author: { type: "human", id: "reviewer" },
      reason: "Reviewed against the billing worker code.",
    });
    assert.equal(confirmed?.verificationState, "confirmed");
    assert.equal(confirmed?.autoInjectEligible, true);

    const after = store.recall({ query: "billing retry key", autoInjectOnly: true });
    assert.equal(after.cards.length, 1);
  });
});

test("strict scopes withhold cited claims but allow verified claims", async () => {
  await withStore((store) => {
    store.remember(
      {
        kind: "fact",
        title: "Session tokens are stored in cookies",
        body: "The auth service stores session tokens in HttpOnly cookies.",
        scope: ["auth/session.ts"],
        citations: [{ type: "file", locator: "docs/decisions.md" }],
      },
      { author },
    );
    const citedStrict = store.recall({
      query: "session tokens cookies",
      scope: ["auth/session.ts"],
      autoInjectOnly: true,
    });
    assert.equal(citedStrict.cards.length, 0);

    store.remember(
      {
        kind: "fact",
        title: "Session cookies are HttpOnly",
        body: "The auth service sets HttpOnly on session cookies.",
        scope: ["auth/session.ts"],
        basis: "verified",
        citations: [{ type: "file", locator: "docs/decisions.md" }],
      },
      { author: { type: "human", id: "reviewer" } },
    );
    const verifiedStrict = store.recall({
      query: "session cookies HttpOnly",
      scope: ["auth/session.ts"],
      autoInjectOnly: true,
    });
    assert.equal(verifiedStrict.cards.length, 1);
    assert.equal(verifiedStrict.cards[0]?.basis, "verified");
  });
});

test("explicit contradictions create a fork and mark both sides disputed", async () => {
  await withStore((store) => {
    const first = store.remember(
      {
        kind: "decision",
        title: "Billing uses an outbox table",
        body: "Billing publishes events through an outbox table.",
        citations: [{ type: "file", locator: "docs/decisions.md" }],
      },
      { author },
    );
    const second = store.remember(
      {
        kind: "decision",
        title: "Billing uses an outbox table",
        body: "Billing publishes events directly, without an outbox.",
        citations: [{ type: "file", locator: "docs/decisions.md" }],
        contradicts: [first.node!.id],
      },
      { author },
    );
    assert.equal(second.action, "conflict");
    assert.notEqual(second.node?.id, first.node?.id);
    assert.equal(second.node?.status, "disputed");
    assert.equal(store.get(first.node!.id)?.node.status, "disputed");
    const edges = store.get(first.node!.id)?.edges ?? [];
    assert.ok(edges.some((edge) => edge.type === "contradicts"));
  });
});

test("neighbors returns linked nodes", async () => {
  await withStore((store) => {
    const target = store.remember(
      {
        kind: "component",
        title: "Memory store",
        body: "The memory store owns persistence and retrieval.",
        citations: [{ type: "file", locator: "docs/decisions.md" }],
      },
      { author },
    );
    const source = store.remember(
      {
        kind: "pattern",
        title: "Recall uses the memory store",
        body: "The recall path delegates to the memory store.",
        citations: [{ type: "file", locator: "docs/decisions.md" }],
        links: [{ to: target.node!.id, type: "depends_on" }],
      },
      { author },
    );
    const neighbors = store.neighbors(source.node!.id, { depth: 1 });
    assert.equal(neighbors?.neighbors.length, 1);
    assert.equal(neighbors?.neighbors[0]?.node.id, target.node?.id);
    assert.equal(neighbors?.neighbors[0]?.edge.type, "depends_on");
  });
});

test("revalidate marks claims with changed file citations stale", async () => {
  await withStore((store, root) => {
    const result = store.remember(
      {
        kind: "fact",
        title: "The project uses SQLite",
        body: "The project uses SQLite for memory.",
        citations: [{ type: "file", locator: "docs/decisions.md" }],
      },
      { author },
    );
    assert.equal(result.node?.status, "active");
    writeFileSync(path.join(root, "docs", "decisions.md"), "# Decisions\n\nChanged source.\n");
    const revalidated = store.revalidate();
    assert.equal(revalidated.markedStale, 1);
    const detail = store.get(result.node!.id);
    assert.equal(detail?.node.status, "stale");
    assert.equal(detail?.node.autoInjectEligible, false);
  });
});

test("write validation rejects secrets and oversized bodies", async () => {
  await withStore((store) => {
    const secret = store.remember(
      {
        kind: "fact",
        title: "A secret",
        body: 'api_key = "sk-abcdefghijklmnopqrstuvwxyz123456"',
      },
      { author },
    );
    assert.equal(secret.action, "rejected");

    const oversized = store.remember(
      {
        kind: "fact",
        title: "An oversized claim",
        body: "x".repeat(7000),
      },
      { author },
    );
    assert.equal(oversized.action, "rejected");
  });
});

test("export includes nodes and manifest data", async () => {
  await withStore((store) => {
    store.remember(
      {
        kind: "decision",
        title: "Export is deterministic",
        body: "Export writes sorted JSONL.",
        citations: [{ type: "file", locator: "docs/decisions.md" }],
      },
      { author },
    );
    const bundle = store.exportBundle();
    assert.equal(bundle.schemaVersion, 1);
    assert.ok(bundle.nodes.length >= 1);
    assert.ok(bundle.versions.length >= 1);
    assert.ok(bundle.citations.length >= 1);
  });
});
