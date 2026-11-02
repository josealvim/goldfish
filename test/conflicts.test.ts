import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/core/store.ts";
import { formatReview } from "../src/core/format.ts";
import { parseConflictVerdict } from "../src/core/conflicts.ts";

const author = { type: "system" as const, id: "test" };

async function withStore(callback: (store: MemoryStore, root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "goldfish-conflicts-"));
  mkdirSync(path.join(root, "docs"), { recursive: true });
  writeFileSync(path.join(root, "docs", "decisions.md"), "# Decisions\n\nConflict source.\n");
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
    kind?: "decision" | "component";
    title: string;
    body?: string;
    scope?: string[];
    tags?: string[];
    links?: Array<{ to: string; type: "applies_to" | "related_to" }>;
  },
) {
  return store.remember(
    {
      kind: input.kind ?? "decision",
      title: input.title,
      body: input.body ?? `${input.title} body.`,
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.links ? { links: input.links } : {}),
      citations: [{ type: "file", locator: "docs/decisions.md" }],
    },
    { author },
  ).node!;
}

test("relatedClaims uses text and graph signals but excludes disjoint scopes and existing conflicts", async () => {
  await withStore((store) => {
    const target = claim(store, {
      title: "Billing outbox",
      body: "Billing publishes events through an outbox table.",
      scope: ["services/billing/**"],
      tags: ["billing", "events"],
    });
    const candidate = claim(store, {
      title: "Billing webhook",
      body: "Billing sends events directly to the provider.",
      scope: ["services/billing/**"],
      tags: ["billing", "events"],
    });
    const disjoint = claim(store, {
      title: "Billing auth note",
      body: "Billing auth uses a session cookie.",
      scope: ["auth/**"],
      tags: ["billing", "auth"],
    });
    const linkedClaim = claim(store, {
      title: "Billing delivery note",
      body: "The worker owns billing delivery.",
      scope: ["services/billing/**"],
      tags: ["billing"],
      links: [{ to: target.id, type: "related_to" }],
    });

    const related = store.relatedClaims(target.id, { limit: 5 });
    const ids = new Set(related.map((node) => node.id));
    assert.equal(ids.has(candidate.id), true);
    assert.equal(ids.has(disjoint.id), false);
    assert.equal(ids.has(linkedClaim.id), true);

    store.markDisputed(candidate.id, author, "Already under review.");
    const withoutDisputed = store.relatedClaims(target.id, { limit: 5 });
    assert.equal(withoutDisputed.some((node) => node.id === candidate.id), false);
  });
});

test("conflict verdict parsing validates candidate IDs and requires evidence", () => {
  const parsed = parseConflictVerdict(
    JSON.stringify({
      conflicts: [
        {
          id: "decision/allowed",
          relation: "contradicts",
          reason: "Weak conflict.",
          evidence: [{ locator: "file:docs/decisions.md", quote: "Conflict source." }],
        },
        {
          id: "decision/allowed",
          relation: "contradicts",
          reason: "Strong conflict.",
          evidence: [
            { locator: "file:docs/decisions.md", quote: "Conflict source." },
            {
              locator: "file:docs/decisions.md",
              quote: "A second source line.",
              why: "It narrows the scope.",
            },
          ],
        },
        {
          id: "decision/unknown",
          relation: "contradicts",
          reason: "Invented candidate.",
          evidence: [{ locator: "file:docs/decisions.md", quote: "Conflict source." }],
        },
        {
          id: "decision/allowed",
          relation: "supersedes",
          reason: "Not a conflict relation.",
          evidence: [{ locator: "file:docs/decisions.md", quote: "Conflict source." }],
        },
        {
          id: "decision/allowed",
          relation: "contradicts",
          reason: "No evidence.",
          evidence: [],
        },
      ],
    }),
    new Set(["decision/allowed"]),
  );
  assert.equal(parsed.cacheable, true);
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0]?.evidence.length, 2);
  assert.match(parsed.findings[0]?.reason ?? "", /Strong conflict/);
  assert.match(parsed.findings[0]?.evidence[1]?.why ?? "", /scope/);

  const invalid = parseConflictVerdict("not json", new Set());
  assert.equal(invalid.cacheable, false);
  assert.match(invalid.error ?? "", /did not return JSON/);
});

test("conflict proposals are canonical, stale on revision, dismissible, and confirmable", async () => {
  await withStore((store) => {
    const target = claim(store, {
      title: "Conflict target",
      body: "The target claim.",
      tags: ["conflict"],
    });
    const candidate = claim(store, {
      title: "Conflict candidate",
      body: "The candidate claim.",
      tags: ["conflict"],
    });
    const input = {
      nodeA: candidate.id,
      nodeB: target.id,
      nodeAVersion: candidate.version,
      nodeBVersion: target.version,
      relation: "contradicts" as const,
      reason: "The claims cannot both be true.",
      evidence: [
        {
          locator: "file:docs/decisions.md",
          quote: "Conflict source.",
          why: "The source defines the conflict.",
        },
      ],
      inputHash: "hash-1",
    };
    const proposal = store.upsertConflictProposal(input)!;
    assert.equal(proposal.nodeA.id, candidate.id);
    assert.equal(proposal.nodeB.id, target.id);
    assert.equal(proposal.id, store.getConflictProposal(target.id, candidate.id)!.id);
    assert.equal(proposal.status, "proposed");
    assert.equal(proposal.stale, false);
    const health = store.health();
    assert.equal(health.counts.conflictProposals, 1);
    assert.match(health.conflictProposals[0]?.id ?? "", /↔/);

    store.remember(
      {
        kind: "decision",
        title: "Conflict target",
        body: "A materially revised target claim.",
        tags: ["conflict"],
        citations: [{ type: "file", locator: "docs/decisions.md" }],
      },
      { author },
    );
    assert.equal(store.getConflictProposal(target.id, candidate.id)!.stale, true);
    assert.throws(
      () =>
        store.confirmConflict(
          target.id,
          candidate.id,
          author,
          "Should require a fresh discovery.",
        ),
      /stale/,
    );

    const refreshed = store.upsertConflictProposal({
      ...input,
      nodeBVersion: store.get(target.id)!.node.version,
      inputHash: "hash-2",
    })!;
    assert.equal(refreshed.stale, false);
    assert.equal(refreshed.inputHash, "hash-2");

    const dismissed = store.dismissConflict(
      target.id,
      candidate.id,
      author,
      "Not a real conflict.",
    )!;
    assert.equal(dismissed.status, "dismissed");
    assert.equal(store.get(target.id)!.node.status, "active");
    assert.equal(store.get(candidate.id)!.node.status, "active");
    const notReproposed = store.upsertConflictProposal({
      ...input,
      nodeBVersion: store.get(target.id)!.node.version,
      inputHash: "hash-3",
    })!;
    assert.equal(notReproposed.status, "dismissed");

    const fresh = claim(store, {
      title: "Conflict target two",
      body: "Another target claim.",
      tags: ["conflict"],
    });
    const freshCandidate = claim(store, {
      title: "Conflict candidate two",
      body: "Another candidate claim.",
      tags: ["conflict"],
    });
    store.upsertConflictProposal({
      nodeA: fresh.id,
      nodeB: freshCandidate.id,
      nodeAVersion: fresh.version,
      nodeBVersion: freshCandidate.version,
      relation: "contradicts",
      reason: "These cannot both be true.",
      evidence: [
        {
          locator: "file:docs/decisions.md",
          quote: "Conflict source.",
          why: "The source defines the conflict.",
        },
      ],
      inputHash: "hash-4",
    });
    const confirmed = store.confirmConflict(
      fresh.id,
      freshCandidate.id,
      author,
      "Confirmed by a human.",
    )!;
    assert.equal(confirmed.status, "confirmed");
    assert.equal(store.get(fresh.id)!.node.status, "disputed");
    assert.equal(store.get(freshCandidate.id)!.node.status, "disputed");
    assert.ok(
      store
        .get(fresh.id)!
        .edges.some(
          (edge) =>
            edge.type === "contradicts" &&
            (edge.toID === freshCandidate.id || edge.fromID === freshCandidate.id),
        ),
    );

    const review = formatReview([], [proposal]);
    assert.match(review, /Proposed conflicts/);
    assert.match(review, /memory_admin\.conflict/);
  });
});
