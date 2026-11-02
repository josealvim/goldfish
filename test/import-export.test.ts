import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/core/store.ts";
import { importBundle, type ImportBundle } from "../src/core/import.ts";

const author = { type: "system" as const, id: "test" };

async function withRoot(callback: (root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "goldfish-import-"));
  mkdirSync(path.join(root, "docs"), { recursive: true });
  writeFileSync(path.join(root, "docs", "decisions.md"), "# Decisions\n\nUse SQLite for project memory.\n");
  try {
    await callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function bundleFrom(store: MemoryStore, nodes = store.exportBundle().nodes): ImportBundle {
  const exported = store.exportBundle();
  return {
    nodes,
    sources: exported.sources as ImportBundle["sources"],
    citations: exported.citations as ImportBundle["citations"],
    edges: exported.edges as ImportBundle["edges"],
  };
}

test("export/import round-trip preserves citations, edges, conflicts, and supersession", async () => {
  await withRoot(async (root) => {
    const source = await MemoryStore.open({ dbPath: ":memory:", projectRoot: root });
    const target = await MemoryStore.open({ dbPath: ":memory:", projectRoot: root });
    try {
      const alpha = source.remember(
        {
          kind: "decision",
          title: "Alpha decision",
          body: "Alpha is the base decision.",
          citations: [{ type: "file", locator: "docs/decisions.md" }],
        },
        { author },
      );
      const beta = source.remember(
        {
          kind: "component",
          title: "Beta component",
          body: "Beta depends on alpha.",
          citations: [{ type: "file", locator: "docs/decisions.md" }],
          links: [{ to: alpha.node!.id, type: "depends_on" }],
        },
        { author },
      );
      const inferred = source.remember(
        {
          kind: "gotcha",
          title: "Inferred gotcha",
          body: "This is an unverified inference.",
          basis: "inferred",
        },
        { author },
      );
      const old = source.remember(
        {
          kind: "decision",
          title: "Old decision",
          body: "This decision is replaced.",
          citations: [{ type: "file", locator: "docs/decisions.md" }],
        },
        { author },
      );
      const next = source.remember(
        {
          kind: "decision",
          title: "New decision",
          body: "This decision replaces the old one.",
          citations: [{ type: "file", locator: "docs/decisions.md" }],
          supersedes: old.node!.id,
        },
        { author },
      );
      const conflictA = source.remember(
        {
          kind: "decision",
          title: "Conflict decision",
          body: "Billing uses an outbox.",
          citations: [{ type: "file", locator: "docs/decisions.md" }],
        },
        { author },
      );
      const conflictB = source.remember(
        {
          kind: "decision",
          title: "Conflict decision",
          body: "Billing publishes directly.",
          citations: [{ type: "file", locator: "docs/decisions.md" }],
          contradicts: [conflictA.node!.id],
        },
        { author },
      );

      const bundle = bundleFrom(source, [...source.exportBundle().nodes].reverse());
      const result = importBundle(target, bundle, { directory: "test-export" });
      assert.equal(result.imported, 7);
      assert.equal(result.counts.created, 6);
      assert.equal(result.counts.conflict, 1);

      const importedAlpha = target.get(alpha.node!.id);
      assert.equal(importedAlpha?.node.basis, "cited");
      assert.equal(importedAlpha?.citations.length, 1);

      const importedBeta = target.get(beta.node!.id);
      assert.ok(importedBeta?.edges.some((edge) => edge.type === "depends_on" && edge.toID === alpha.node!.id));

      const importedInferred = target.get(inferred.node!.id);
      assert.equal(importedInferred?.node.basis, "inferred");
      assert.equal(importedInferred?.node.verificationState, "unverified");
      assert.equal(importedInferred?.node.autoInjectEligible, false);

      assert.equal(target.get(old.node!.id)?.node.status, "superseded");
      assert.ok(target.get(next.node!.id)?.edges.some((edge) => edge.type === "supersedes"));

      assert.equal(target.get(conflictA.node!.id)?.node.status, "disputed");
      assert.equal(target.get(conflictB.node!.id)?.node.status, "disputed");
      assert.ok(
        target
          .get(conflictA.node!.id)
          ?.edges.some((edge) => edge.type === "contradicts" && edge.fromID === conflictB.node!.id),
      );
    } finally {
      source.close();
      target.close();
    }
  });
});

test("import downgrades citations whose files are missing", async () => {
  await withRoot(async (root) => {
    const source = await MemoryStore.open({ dbPath: ":memory:", projectRoot: root });
    const targetRoot = mkdtempSync(path.join(tmpdir(), "goldfish-missing-"));
    const target = await MemoryStore.open({ dbPath: ":memory:", projectRoot: targetRoot });
    try {
      const node = source.remember(
        {
          kind: "fact",
          title: "File-backed claim",
          body: "This claim cites a document.",
          citations: [{ type: "file", locator: "docs/decisions.md" }],
        },
        { author },
      );
      const bundle = bundleFrom(source);
      unlinkSync(path.join(root, "docs", "decisions.md"));
      const result = importBundle(target, bundle);
      assert.equal(result.counts.created, 1);
      const imported = target.get(node.node!.id);
      assert.equal(imported?.node.basis, "inferred");
      assert.equal(imported?.node.verificationState, "unverified");
      assert.equal(imported?.node.autoInjectEligible, false);
    } finally {
      source.close();
      target.close();
      rmSync(targetRoot, { recursive: true, force: true });
    }
  });
});
