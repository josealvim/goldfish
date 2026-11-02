import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/core/store.ts";
import { buildRepairPacket, formatRepairPacket } from "../src/core/repair.ts";

const author = { type: "system" as const, id: "test" };

async function withStore(callback: (store: MemoryStore, root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "goldfish-repair-"));
  mkdirSync(path.join(root, "docs"), { recursive: true });
  writeFileSync(path.join(root, "docs", "source.md"), "# Source\n\nThe outbox retries failed deliveries.\n");
  const store = await MemoryStore.open({ dbPath: ":memory:", projectRoot: root });
  try {
    await callback(store, root);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function claim(
  store: MemoryStore,
  input: {
    title: string;
    body?: string;
    basis?: "verified" | "cited" | "derived" | "inferred";
    citations?: Array<{ type: "file" | "test"; locator: string; excerpt?: string }>;
    links?: Array<{ to: string; type: "derived_from" }>;
    metadata?: Record<string, unknown>;
  },
) {
  return store.remember(
    {
      kind: "decision",
      title: input.title,
      body: input.body ?? `${input.title} body.`,
      ...(input.basis ? { basis: input.basis } : {}),
      ...(input.citations ? { citations: input.citations } : {}),
      ...(input.links ? { links: input.links } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
    { author },
  ).node!;
}

test("repair packet recommends recite or revise for stale and missing evidence", async () => {
  await withStore((store, root) => {
    const stale = claim(store, {
      title: "Stale delivery",
      body: "The outbox retries failed deliveries.",
      basis: "cited",
      citations: [
        {
          type: "file",
          locator: "docs/source.md",
          excerpt: "The outbox retries failed deliveries.",
        },
      ],
    });
    writeFileSync(path.join(root, "docs", "source.md"), "# Source\n\nChanged.\n");
    const stalePacket = buildRepairPacket(store, stale.id)!;
    assert.equal(stalePacket.suggestedTier, "agent_content");
    assert.equal(stalePacket.actions.some((action) => action.action === "recite"), true);
    assert.equal(stalePacket.actions.some((action) => action.action === "revise"), true);
    assert.match(formatRepairPacket(stalePacket), /Repair packet/);

    const unsupported = claim(store, {
      title: "Missing evidence",
      basis: "inferred",
    });
    const unsupportedPacket = buildRepairPacket(store, unsupported.id)!;
    assert.equal(unsupportedPacket.actions.some((action) => action.action === "recite"), true);
    assert.equal(unsupportedPacket.actions.some((action) => action.action === "reject"), true);
  });
});

test("repair packet routes disputes and ratification to human authority", async () => {
  await withStore((store) => {
    const target = claim(store, {
      title: "Disputed delivery",
      body: "Billing publishes through an outbox.",
      citations: [{ type: "file", locator: "docs/source.md" }],
    });
    const competitor = claim(store, {
      title: "Competing delivery",
      body: "Billing publishes directly.",
      citations: [{ type: "file", locator: "docs/source.md" }],
    });
    store.remember(
      {
        kind: "decision",
        title: "Competing delivery fork",
        body: "Billing publishes directly to the provider.",
        citations: [{ type: "file", locator: "docs/source.md" }],
        contradicts: [target.id],
      },
      { author },
    );
    const disputed = store.get(target.id)!.node;
    assert.equal(disputed.status, "disputed");
    const disputedPacket = buildRepairPacket(store, target.id)!;
    assert.equal(disputedPacket.suggestedTier, "human_authority");
    assert.equal(disputedPacket.actions.some((action) => action.action === "revise"), true);
    assert.equal(disputedPacket.actions.some((action) => action.action === "archive"), true);
    store.upsertConflictProposal({
      nodeA: target.id,
      nodeB: competitor.id,
      nodeAVersion: target.version,
      nodeBVersion: competitor.version,
      relation: "contradicts",
      reason: "They disagree.",
      evidence: [{ locator: "docs/source.md", quote: "Conflict source." }],
      inputHash: "repair-conflict",
    });
    assert.equal(buildRepairPacket(store, target.id)!.conflicts.length, 1);

    const ratification = claim(store, {
      title: "Ratification candidate",
      basis: "inferred",
      citations: [{ type: "file", locator: "docs/source.md" }],
      metadata: { ratificationSuggested: { basis: "verified", reason: "Model suggested it." } },
    });
    const ratificationPacket = buildRepairPacket(store, ratification.id)!;
    assert.equal(
      ratificationPacket.actions.some((action) => action.action === "confirm_verified"),
      true,
    );
    assert.equal(ratificationPacket.suggestedTier, "human_authority");
  });
});

test("repair packet handles clean and derived claims", async () => {
  await withStore((store) => {
    const clean = claim(store, {
      title: "Clean claim",
      basis: "cited",
      citations: [{ type: "file", locator: "docs/source.md" }],
    });
    const cleanPacket = buildRepairPacket(store, clean.id)!;
    assert.equal(cleanPacket.suggestedTier, "none");
    assert.deepEqual(
      cleanPacket.actions.map((action) => action.action),
      ["leave_for_review"],
    );

    const premise = claim(store, {
      title: "Derived premise",
      basis: "cited",
      citations: [{ type: "file", locator: "docs/source.md" }],
    });
    const derived = claim(store, {
      title: "Derived conclusion",
      basis: "derived",
      links: [{ to: premise.id, type: "derived_from" }],
    });
    const derivedPacket = buildRepairPacket(store, derived.id)!;
    assert.equal(
      derivedPacket.actions.some((action) => action.action === "confirm_derived"),
      true,
    );
    assert.equal(derivedPacket.suggestedTier, "agent_content");
  });
});

test("repair revisions record the supplied reason in version history", async () => {
  await withStore((store) => {
    const created = claim(store, {
      title: "Repair reason",
      basis: "cited",
      citations: [{ type: "file", locator: "docs/source.md" }],
    });
    const revised = store.remember(
      {
        kind: "decision",
        title: "Repair reason",
        body: "A corrected body with current evidence.",
        citations: [{ type: "file", locator: "docs/source.md" }],
        reason: "repair: re-cited the current source",
      },
      { author },
    ).node!;
    assert.equal(revised.version, created.version + 1);
    const versions = store.get(created.id)!.versions;
    assert.equal(versions[0]?.reason, "repair: re-cited the current source");
  });
});
