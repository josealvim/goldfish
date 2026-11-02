import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/core/store.ts";
import { formatMemoryStatus } from "../src/core/format.ts";

const author = { type: "system" as const, id: "test" };

async function withStore(callback: (store: MemoryStore) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "goldfish-status-"));
  mkdirSync(path.join(root, "docs"), { recursive: true });
  writeFileSync(path.join(root, "docs", "decisions.md"), "# Decisions\n\nStatus source.\n");
  const store = await MemoryStore.open({ dbPath: ":memory:", projectRoot: root });
  try {
    await callback(store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function remember(store: MemoryStore, kind: "concept" | "component" | "decision" | "gotcha", title: string, links?: Array<{ to: string; type: "part_of" }>) {
  return store.remember(
    {
      kind,
      title,
      body: `${title} body.`,
      citations: [{ type: "file", locator: "docs/decisions.md" }],
      links,
    },
    { author },
  );
}

test("status moves from empty to recommended, partial, and complete", async () => {
  await withStore((store) => {
    const empty = store.status();
    assert.equal(empty.state, "empty");
    assert.equal(empty.overview, false);
    assert.equal(empty.onboardingRecommended, true);
    assert.match(formatMemoryStatus(empty), /Onboarding: empty/);

    remember(store, "concept", "Project overview");
    const recommended = store.status();
    assert.equal(recommended.state, "recommended");
    assert.equal(recommended.overview, true);
    assert.equal(recommended.onboardingRecommended, true);

    remember(store, "component", "Core component", [
      { to: "concept/project-overview", type: "part_of" },
    ]);
    const partial = store.status();
    assert.equal(partial.state, "partial");
    assert.equal(partial.onboardingRecommended, false);
    assert.match(formatMemoryStatus(partial), /Onboarding: partial/);

    remember(store, "decision", "Core decision");
    assert.equal(store.status().state, "partial");

    remember(store, "gotcha", "Core gotcha");
    const complete = store.status();
    assert.equal(complete.state, "complete");
    assert.equal(complete.overview, true);
    assert.equal(complete.onboardingRecommended, false);
    assert.ok((complete.kinds.component ?? 0) >= 1);
    assert.match(formatMemoryStatus(complete), /Onboarding: complete/);
  });
});

test("status ignores an archived overview", async () => {
  await withStore((store) => {
    const overview = remember(store, "concept", "Project overview");
    remember(store, "component", "Core component");
    store.recordAudit({
      nodeID: overview.node!.id,
      version: overview.node!.version,
      trigger: "manual",
      outcome: "malicious",
    });
    const status = store.status();
    assert.equal(status.overview, false);
    assert.equal(status.state, "recommended");
  });
});
