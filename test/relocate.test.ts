import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/core/store.ts";

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

test("cloneFrom copies nodes, versions, edges, and searchable FTS into a live target", async () => {
  const root = tempDir("goldfish-clone-");
  const sourcePath = path.join(root, "source.sqlite");
  const targetPath = path.join(root, "target.sqlite");
  try {
    const source = await MemoryStore.open({ dbPath: sourcePath, projectRoot: root });
    source.remember(
      {
        kind: "component",
        title: "Core component",
        body: "The core component coordinates storage.",
        citations: [{ type: "file", locator: "README.md" }],
      },
      { author: { type: "system", id: "test" } },
    );
    source.remember(
      {
        kind: "decision",
        title: "Use the core component",
        body: "The decision depends on the core component.",
        citations: [{ type: "file", locator: "README.md" }],
        links: [{ to: "component/core-component", type: "depends_on" }],
      },
      { author: { type: "system", id: "test" } },
    );
    source.remember(
      {
        kind: "component",
        title: "Core component",
        body: "The core component coordinates storage and retrieval.",
        citations: [{ type: "file", locator: "README.md" }],
      },
      { author: { type: "system", id: "test" } },
    );
    source.close();

    const target = await MemoryStore.open({
      dbPath: targetPath,
      projectRoot: root,
      projectId: "11111111-1111-4111-8111-111111111111",
    });
    try {
      const result = target.cloneFrom(sourcePath, { sourceProjectRoot: root });
      assert.equal(result.nodes, 2);
      assert.ok(result.versions >= 3);
      assert.equal(result.edges, 1);
      assert.ok(result.events >= 3);
      assert.equal(target.status().total, 2);
      assert.match(target.recall({ query: "retrieval" }).cards[0]?.title ?? "", /Core component/);
      assert.equal(target.get("decision/use-the-core-component")?.node.title, "Use the core component");
    } finally {
      target.close();
    }

    assert.equal(existsSync(sourcePath), true);
    assert.equal(existsSync(targetPath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cloneFrom refuses a non-empty target and supports a dry run", async () => {
  const root = tempDir("goldfish-clone-");
  const sourcePath = path.join(root, "source.sqlite");
  const targetPath = path.join(root, "target.sqlite");
  try {
    const source = await MemoryStore.open({ dbPath: sourcePath, projectRoot: root });
    source.remember(
      {
        kind: "gotcha",
        title: "Source gotcha",
        body: "Something to clone.",
        citations: [{ type: "file", locator: "README.md" }],
      },
      { author: { type: "system", id: "test" } },
    );
    source.close();

    const target = await MemoryStore.open({ dbPath: targetPath, projectRoot: root });
    try {
      const preview = target.cloneFrom(sourcePath, { dryRun: true });
      assert.equal(preview.dryRun, true);
      assert.equal(preview.adopted, false);
      assert.equal(preview.nodes, 1);
      assert.equal(target.status().total, 0);

      target.remember(
        {
          kind: "gotcha",
          title: "Target gotcha",
          body: "Target memory stays put.",
          citations: [{ type: "file", locator: "README.md" }],
        },
        { author: { type: "system", id: "test" } },
      );
      assert.throws(() => target.cloneFrom(sourcePath), /already contains 1 memory node/);
    } finally {
      target.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
