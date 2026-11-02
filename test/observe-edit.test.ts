import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/core/store.ts";

const author = { type: "system" as const, id: "test" };
const write = { author };

async function withStore(callback: (store: MemoryStore) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "goldfish-observe-"));
  mkdirSync(path.join(root, "docs"), { recursive: true });
  writeFileSync(path.join(root, "docs", "decisions.md"), "# Decisions\n\nObserve and edit source.\n");
  const store = await MemoryStore.open({ dbPath: ":memory:", projectRoot: root });
  try {
    await callback(store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function cited(
  store: MemoryStore,
  title: string,
  kind: "decision" | "gotcha" | "component" | "concept" = "decision",
  options: { scope?: string[]; tags?: string[]; confidence?: number } = {},
) {
  return store.remember(
    {
      kind,
      title,
      body: `${title} body.`,
      scope: options.scope,
      tags: options.tags,
      confidence: options.confidence,
      citations: [{ type: "file", locator: "docs/decisions.md" }],
    },
    write,
  );
}

test("memory_list filters, counts, and paginates", async () => {
  await withStore((store) => {
    const decision = cited(store, "Alpha decision", "decision", {
      scope: ["src/**"],
      tags: ["alpha"],
    });
    cited(store, "Beta gotcha", "gotcha", { scope: ["services/**"], tags: ["beta"] });
    store.remember(
      { kind: "fact", title: "Inferred fact", body: "Inferred body.", scope: ["docs/**"], basis: "inferred" },
      write,
    );
    const archived = cited(store, "Archived decision");
    store.archive(archived.node!.id, write, "test");

    const decisions = store.list({ kinds: ["decision"], statuses: ["active"] });
    assert.equal(decisions.total, 1);
    assert.equal(decisions.items[0]?.id, decision.node!.id);
    assert.equal(decisions.items[0]?.citationCount, 1);

    const inferred = store.list({ bases: ["inferred"] });
    assert.equal(inferred.total, 1);
    assert.equal(inferred.items[0]?.basis, "inferred");

    const tagged = store.list({ tag: "beta" });
    assert.equal(tagged.total, 1);
    assert.equal(tagged.items[0]?.title, "Beta gotcha");

    const scoped = store.list({ scope: "services/**" });
    assert.ok(scoped.items.some((item) => item.title === "Beta gotcha"));

    const archivedList = store.list({ statuses: ["archived"] });
    assert.equal(archivedList.total, 1);

    const firstPage = store.list({ limit: 1, offset: 0 });
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.nextOffset, 1);
    assert.equal(firstPage.total, 4);

    const secondPage = store.list({ limit: 1, offset: 1 });
    assert.equal(secondPage.items[0]?.id !== firstPage.items[0]?.id, true);
  });
});

test("memory_health reports actionable issues and coverage", async () => {
  await withStore((store) => {
    const empty = store.health();
    assert.equal(empty.total, 0);
    assert.equal(empty.onboarding, "empty");
    assert.equal(empty.overview.present, false);

    const overview = cited(store, "Project overview", "concept");
    const component = cited(store, "Core component", "component");
    store.link(component.node!.id, overview.node!.id, "part_of", write);
    cited(store, "Core decision");
    cited(store, "Core gotcha", "gotcha");
    const uncited = store.remember(
      { kind: "gotcha", title: "Uncited gotcha", body: "No source.", basis: "inferred" },
      write,
    );
    const low = cited(store, "Low confidence", "decision", { confidence: 0.4 });
    const stale = cited(store, "Stale decision");
    store.markStale(stale.node!.id, author, "test");
    const disputed = cited(store, "Disputed decision");
    store.markDisputed(disputed.node!.id, author, "test");
    const renamed = cited(store, "Renamed old");
    store.update(renamed.node!.id, { title: "Renamed new" }, write);

    const health = store.health();
    assert.equal(health.onboarding, "complete");
    assert.equal(health.overview.present, true);
    assert.equal(health.overview.linkedComponents, 1);
    assert.ok(health.citationCoverage > 0 && health.citationCoverage <= 1);
    assert.ok(health.counts.uncited >= 1);
    assert.ok(health.uncited.some((issue) => issue.id === uncited.node!.id));
    assert.ok(health.counts.lowConfidence >= 1);
    assert.ok(health.lowConfidence.some((issue) => issue.id === low.node!.id));
    assert.ok(health.counts.stale >= 1);
    assert.ok(health.stale.some((issue) => issue.id === stale.node!.id));
    assert.ok(health.counts.disputed >= 1);
    assert.ok(health.disputed.some((issue) => issue.id === disputed.node!.id));
    assert.ok(health.counts.renamedIds >= 1);
    assert.ok(health.renamedIds.some((issue) => issue.id === renamed.node!.id));
    assert.ok(health.counts.auditBacklog >= 1);

    const before = health.counts.auditBacklog;
    store.recordAudit({
      nodeID: component.node!.id,
      version: component.node!.version,
      trigger: "manual",
      outcome: "supported",
    });
    assert.equal(store.health().counts.auditBacklog, before - 1);
  });
});

test("memory_cite adds citations without promoting the claim", async () => {
  await withStore((store) => {
    const node = store.remember(
      { kind: "gotcha", title: "Cite target", body: "Cite target body.", basis: "inferred" },
      write,
    );
    const citedNode = store.cite(node.node!.id, [{ type: "file", locator: "docs/decisions.md" }], write);
    assert.equal(citedNode.basis, "inferred");
    assert.equal(citedNode.autoInjectEligible, false);
    assert.equal(store.get(node.node!.id)?.citations.length, 1);

    assert.throws(
      () => store.cite(node.node!.id, [{ type: "file", locator: "missing.md" }], write),
      /Citation file\(s\) missing/,
    );

    store.archive(node.node!.id, write, "test");
    assert.throws(
      () => store.cite(node.node!.id, [{ type: "file", locator: "docs/decisions.md" }], write),
      /archived/,
    );
  });
});

test("memory_link and memory_unlink manage edges without deleting history", async () => {
  await withStore((store) => {
    const first = cited(store, "Link first");
    const second = cited(store, "Link second");

    const edge = store.link(first.node!.id, second.node!.id, "depends_on", write);
    assert.equal(edge.type, "depends_on");
    assert.ok(store.get(first.node!.id)?.edges.some((item) => item.type === "depends_on"));

    assert.equal(store.unlink(first.node!.id, second.node!.id, "depends_on", write), true);
    assert.equal(store.get(first.node!.id)?.edges.some((item) => item.type === "depends_on"), false);
    assert.equal(store.unlink(first.node!.id, second.node!.id, "depends_on", write), false);

    assert.throws(() => store.link(first.node!.id, first.node!.id, "depends_on", write), /itself/);
    assert.throws(() => store.link(first.node!.id, "decision/missing", "depends_on", write), /must exist/);
    assert.throws(
      () => store.link(first.node!.id, second.node!.id, "supersedes", write),
      /revision workflow/,
    );
  });
});

test("memory_update changes title, scope, and tags while keeping the ID stable", async () => {
  await withStore((store) => {
    const node = cited(store, "Update old", "decision", { scope: ["src/**"], tags: ["old"] });
    const updated = store.update(
      node.node!.id,
      { title: "Update new", scope: ["services/**"], tags: ["new"] },
      write,
    );
    assert.equal(updated.id, node.node!.id);
    assert.equal(updated.canonicalKey, node.node!.canonicalKey);
    assert.equal(updated.title, "Update new");
    assert.deepEqual(updated.scope, ["services/**"]);
    assert.deepEqual(updated.tags, ["new"]);

    cited(store, "Update new");
    const other = cited(store, "Another old");
    assert.throws(() => store.update(other.node!.id, { title: "Update new" }, write), /already uses/);

    store.archive(other.node!.id, write, "test");
    assert.throws(() => store.update(other.node!.id, { title: "Archived edit" }, write), /archived/);
  });
});

test("memory_archive is a soft delete that preserves get and excludes default recall", async () => {
  await withStore((store) => {
    const node = cited(store, "Archive target");
    const archived = store.archive(node.node!.id, write, "test");
    assert.equal(archived.status, "archived");
    assert.equal(archived.autoInjectEligible, false);
    assert.equal(store.get(node.node!.id)?.node.status, "archived");
    assert.equal(store.recall({ query: "Archive target" }).cards.length, 0);
    assert.equal(store.list({ statuses: ["archived"] }).total, 1);
  });
});

test("memory_get returns audit and injection history", async () => {
  await withStore((store) => {
    const node = cited(store, "History target");
    store.recordAudit({
      nodeID: node.node!.id,
      version: node.node!.version,
      trigger: "manual",
      outcome: "supported",
    });
    const recalled = store.recall({ query: "History target" });
    store.recordInjections("ses_test", "msg_test", recalled.cards, "tool");
    const detail = store.get(node.node!.id);
    assert.equal(detail?.audits.length, 1);
    assert.equal(detail?.injections.length, 1);
    assert.equal(detail?.injections[0]?.source, "tool");
  });
});
