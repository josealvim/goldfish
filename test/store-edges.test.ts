import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/core/store.ts";

const author = { type: "system" as const, id: "test" };

async function withStore(callback: (store: MemoryStore, root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "goldfish-edges-"));
  mkdirSync(path.join(root, "docs"), { recursive: true });
  writeFileSync(path.join(root, "docs", "decisions.md"), "# Decisions\n\nEdge case source.\n");
  const store = await MemoryStore.open({ dbPath: ":memory:", projectRoot: root });
  try {
    await callback(store, root);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function cited(store: MemoryStore, title: string, body = `${title} body.`, links?: Array<{ to: string; type: "depends_on" | "implements" }>) {
  return store.remember(
    {
      kind: "decision",
      title,
      body,
      citations: [{ type: "file", locator: "docs/decisions.md" }],
      links,
    },
    { author },
  );
}

test("material revisions create a version and reset inferred verification", async () => {
  await withStore((store) => {
    const first = store.remember(
      {
        kind: "gotcha",
        title: "Revision target",
        body: "First body.",
        basis: "inferred",
      },
      { author },
    );
    store.confirm(first.node!.id, {
      as: "verified",
      author: { type: "human", id: "reviewer" },
    });
    const revised = store.remember(
      {
        kind: "gotcha",
        title: "Revision target",
        body: "Second body.",
        basis: "inferred",
      },
      { author },
    );
    assert.equal(revised.action, "revised");
    assert.equal(revised.node?.version, 3);
    assert.equal(revised.node?.verificationState, "unverified");
    assert.equal(revised.node?.autoInjectEligible, false);
    assert.equal(store.get(first.node!.id)?.versions.length, 3);
  });
});

test("supersedes marks the old claim and records the edge", async () => {
  await withStore((store) => {
    const old = cited(store, "Old claim");
    const replacement = store.remember(
      {
        kind: "decision",
        title: "New claim",
        body: "Replacement body.",
        citations: [{ type: "file", locator: "docs/decisions.md" }],
        supersedes: old.node!.id,
      },
      { author },
    );
    assert.equal(store.get(old.node!.id)?.node.status, "superseded");
    assert.ok(store.get(replacement.node!.id)?.edges.some((edge) => edge.type === "supersedes"));
  });
});

test("multiple contradictions create distinct forks", async () => {
  await withStore((store) => {
    const first = cited(store, "First target");
    const second = cited(store, "Second target");
    const forkA = store.remember(
      {
        kind: "decision",
        title: "Conflict claim",
        body: "Same conflicting body.",
        citations: [{ type: "file", locator: "docs/decisions.md" }],
        contradicts: [first.node!.id],
      },
      { author },
    );
    const forkB = store.remember(
      {
        kind: "decision",
        title: "Conflict claim",
        body: "Same conflicting body.",
        citations: [{ type: "file", locator: "docs/decisions.md" }],
        contradicts: [second.node!.id],
      },
      { author },
    );
    assert.notEqual(forkA.node?.id, forkB.node?.id);
    assert.equal(forkA.node?.status, "disputed");
    assert.equal(forkB.node?.status, "disputed");
    assert.equal(store.get(first.node!.id)?.node.status, "disputed");
    assert.equal(store.get(second.node!.id)?.node.status, "disputed");
  });
});

test("recall filters, budgets, empty queries, and FTS punctuation work", async () => {
  await withStore((store) => {
    for (let index = 0; index < 5; index++) {
      store.remember(
        {
          kind: "decision",
          title: `Alpha claim ${index}`,
          body: `Alpha claim ${index} body.`,
          citations: [{ type: "file", locator: "docs/decisions.md" }],
        },
        { author },
      );
    }
    store.remember(
      {
        kind: "gotcha",
        title: "Alpha gotcha",
        body: "Alpha gotcha body.",
        citations: [{ type: "file", locator: "docs/decisions.md" }],
      },
      { author },
    );
    const inferred = store.remember(
      {
        kind: "fact",
        title: "Alpha inference",
        body: "Alpha inference body.",
        basis: "inferred",
      },
      { author },
    );
    const disputed = cited(store, "Alpha disputed");
    store.markDisputed(disputed.node!.id, author, "test");

    const limited = store.recall({ query: "alpha", limit: 2 });
    assert.equal(limited.cards.length, 2);
    assert.equal(limited.hasMore, true);

    const gotchasOnly = store.recall({ query: "alpha", kinds: ["gotcha"] });
    assert.ok(gotchasOnly.cards.length >= 1);
    assert.ok(gotchasOnly.cards.every((card) => card.kind === "gotcha"));

    const withoutInferred = store.recall({ query: "alpha inference", includeInferred: false });
    assert.equal(withoutInferred.cards.some((card) => card.id === inferred.node!.id), false);

    const withoutDisputed = store.recall({ query: "alpha disputed" });
    assert.equal(withoutDisputed.cards.some((card) => card.id === disputed.node!.id), false);
    const withDisputed = store.recall({ query: "alpha disputed", includeDisputed: true });
    assert.equal(withDisputed.cards.some((card) => card.id === disputed.node!.id), true);

    const empty = store.recall({ query: "" });
    assert.ok(empty.cards.length > 0);

    const punctuation = store.recall({ query: '"alpha" OR beta' });
    assert.ok(punctuation.cards.length > 0);

    const tight = store.recall({ query: "alpha", limit: 10, budgetTokens: 100 });
    assert.ok(tight.tokens <= 100);
    assert.ok(tight.cards.length < 5);
  });
});

test("graph expansion is below the seed and does not drag in hub neighbors", async () => {
  await withStore((store) => {
    const hub = store.remember(
      {
        kind: "component",
        title: "Memory hub",
        body: "A hub component.",
        citations: [{ type: "file", locator: "docs/decisions.md" }],
      },
      { author },
    ).node!;
    const hubA = cited(store, "Hub implementation A", "Hub implementation A body.", [
      { to: hub.id, type: "implements" },
    ]);
    const hubB = cited(store, "Hub implementation B", "Hub implementation B body.", [
      { to: hub.id, type: "implements" },
    ]);
    const audit = cited(store, "Audit sampling decision", "Audit sampling uses a 3% uniform sample.");
    const dependency = store.remember(
      {
        kind: "pattern",
        title: "Audit sampling dependency",
        body: "Audit sampling depends on the injection log.",
        citations: [{ type: "file", locator: "docs/decisions.md" }],
        links: [{ to: audit.node!.id, type: "depends_on" }],
      },
      { author },
    ).node!;

    const result = store.recall({ query: "audit sampling", limit: 6 });
    const ids = result.cards.map((card) => card.id);
    assert.ok(ids.includes(audit.node!.id));
    assert.ok(ids.includes(dependency.id));
    assert.equal(ids.includes(hubA.node!.id), false);
    assert.equal(ids.includes(hubB.node!.id), false);
  });
});

test("merge writes persist newly added links and supersession", async () => {
  await withStore((store) => {
    const target = cited(store, "Merge target");
    const source = cited(store, "Merge source");
    const merged = store.remember(
      {
        kind: "decision",
        title: "Merge source",
        body: "Merge source body.",
        citations: [{ type: "file", locator: "docs/decisions.md" }],
        links: [{ to: target.node!.id, type: "depends_on" }],
        supersedes: target.node!.id,
      },
      { author },
    );
    assert.equal(merged.action, "merged");
    assert.ok(
      store
        .get(source.node!.id)
        ?.edges.some((edge) => edge.type === "depends_on" && edge.toID === target.node!.id),
    );
    assert.equal(store.get(target.node!.id)?.node.status, "superseded");
  });
});

test("titles with the same slug revise one node instead of duplicating", async () => {
  await withStore((store) => {
    const first = cited(store, "Use SQLite!");
    const second = store.remember(
      {
        kind: "decision",
        title: "Use SQLite?",
        body: "A different body for the same slug.",
        citations: [{ type: "file", locator: "docs/decisions.md" }],
      },
      { author },
    );
    assert.equal(first.node?.id, second.node?.id);
    assert.equal(second.action, "revised");
    assert.equal(store.get(first.node!.id)?.node.version, 2);
  });
});
