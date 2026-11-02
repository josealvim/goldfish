import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/core/store.ts";

const author = { type: "system" as const, id: "test" };

async function withStore(callback: (store: MemoryStore, root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "goldfish-audit-"));
  mkdirSync(path.join(root, "docs"), { recursive: true });
  writeFileSync(path.join(root, "docs", "decisions.md"), "# Decisions\n\nAudit target.\n");
  const store = await MemoryStore.open({ dbPath: ":memory:", projectRoot: root });
  try {
    await callback(store, root);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function cited(store: MemoryStore, title: string) {
  return store.remember(
    {
      kind: "decision",
      title,
      body: `${title} body.`,
      citations: [{ type: "file", locator: "docs/decisions.md" }],
    },
    { author },
  );
}

test("audit sampling is deterministic and can select uniform or risk candidates", async () => {
  await withStore((store) => {
    cited(store, "Audit target");
    const uniform = store.auditCandidates({ uniformRate: 1, riskRate: 0, max: 10 });
    assert.equal(uniform.length, 1);
    assert.equal(uniform[0]?.trigger, "uniform");

    const risk = store.auditCandidates({ uniformRate: 0, riskRate: 1, max: 10 });
    assert.equal(risk.length, 1);
    assert.equal(risk[0]?.trigger, "risk");

    const none = store.auditCandidates({ uniformRate: 0, riskRate: 0, max: 10 });
    assert.equal(none.length, 0);
  });
});

test("recent audits place claims in a cooldown without hiding revised versions", async () => {
  await withStore((store) => {
    const created = cited(store, "Cooldown target");
    store.recordAudit({
      nodeID: created.node!.id,
      version: created.node!.version,
      trigger: "manual",
      outcome: "supported",
    });
    assert.equal(store.auditCandidates({ uniformRate: 1, riskRate: 1, max: 10 }).length, 0);

    store.remember(
      {
        kind: "decision",
        title: "Cooldown target",
        body: "A materially revised body resets the audit cooldown.",
        citations: [{ type: "file", locator: "docs/decisions.md" }],
      },
      { author },
    );
    assert.equal(store.auditCandidates({ uniformRate: 1, riskRate: 1, max: 10 }).length, 1);
  });
});

test("recordAudit applies lifecycle outcomes", async () => {
  await withStore((store) => {
    const cases = [
      ["contradicted", "disputed"],
      ["stale", "stale"],
      ["malicious", "archived"],
    ] as const;

    for (const [outcome, expectedStatus] of cases) {
      const created = cited(store, `Audit ${outcome}`);
      store.recordAudit({
        nodeID: created.node!.id,
        version: created.node!.version,
        trigger: "manual",
        outcome,
      });
      assert.equal(store.get(created.node!.id)?.node.status, expectedStatus);
      assert.equal(store.get(created.node!.id)?.node.autoInjectEligible, false);
    }

    const insufficient = cited(store, "Audit insufficient");
    store.recordAudit({
      nodeID: insufficient.node!.id,
      version: insufficient.node!.version,
      trigger: "manual",
      outcome: "insufficient",
    });
    const insufficientNode = store.get(insufficient.node!.id)!.node;
    assert.equal(insufficientNode.verificationState, "needs_human");
    assert.equal(insufficientNode.autoInjectEligible, false);

    const supported = cited(store, "Audit supported");
    store.recordAudit({
      nodeID: supported.node!.id,
      version: supported.node!.version,
      trigger: "manual",
      outcome: "supported",
    });
    const supportedNode = store.get(supported.node!.id)!.node;
    assert.ok(supportedNode.lastConfirmedAt);
    assert.ok(supportedNode.confidence >= 0.7);

    assert.equal(store.stats().audits, 5);
  });
});

test("revalidation is idempotent", async () => {
  await withStore((store, root) => {
    cited(store, "Revalidate one");
    cited(store, "Revalidate two");
    writeFileSync(path.join(root, "docs", "decisions.md"), "# Decisions\n\nChanged.\n");

    assert.deepEqual(store.revalidate(), { checked: 2, markedStale: 2 });
    assert.deepEqual(store.revalidate(), { checked: 0, markedStale: 0 });
  });
});
