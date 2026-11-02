import test from "node:test";
import assert from "node:assert/strict";
import {
  loadConflictCases,
  loadSupportCases,
  runConflictEval,
  runSupportEval,
  type ConflictEvalCase,
  type SupportEvalCase,
} from "../src/core/eval.ts";
import type { Verifier } from "../src/core/verification.ts";
import type { ConflictVerifier } from "../src/core/conflicts.ts";

const supportCases: SupportEvalCase[] = [
  {
    name: "direct support",
    files: {
      "docs/source.md": "# Billing\n\nThe outbox retries failed deliveries.",
    },
    nodes: [
      {
        kind: "decision",
        title: "Outbox retries",
        body: "Billing retries failed deliveries through an outbox.",
        basis: "cited",
        citations: [
          {
            type: "file",
            locator: "docs/source.md",
            excerpt: "The outbox retries failed deliveries.",
          },
        ],
      },
    ],
    target: "Outbox retries",
    expect: {
      verdict: "supported",
      evidence: ["outbox retries failed deliveries"],
    },
  },
];

const conflictCases: ConflictEvalCase[] = [
  {
    name: "direct conflict",
    files: {
      "docs/outbox.md": "# Billing\n\nBilling publishes through an outbox.",
      "docs/direct.md": "# Billing\n\nBilling publishes directly to the provider.",
    },
    nodes: [
      {
        kind: "decision",
        title: "Billing outbox eval",
        body: "Billing publishes through an outbox.",
        basis: "cited",
        scope: ["services/billing/**"],
        tags: ["billing", "events"],
        citations: [
          {
            type: "file",
            locator: "docs/outbox.md",
            excerpt: "Billing publishes through an outbox.",
          },
        ],
      },
      {
        kind: "decision",
        title: "Billing direct eval",
        body: "Billing publishes directly to the provider.",
        basis: "cited",
        scope: ["services/billing/**"],
        tags: ["billing", "events"],
        citations: [
          {
            type: "file",
            locator: "docs/direct.md",
            excerpt: "Billing publishes directly to the provider.",
          },
        ],
      },
    ],
    target: "Billing outbox eval",
    expect: {
      conflicts: ["Billing direct eval"],
      evidence: ["publishes directly"],
    },
  },
];

const supportVerifier: Verifier = {
  async verify(packet) {
    return {
      verdict: "supported",
      suggestedAction: "confirm",
      reason: "The source directly states the claim.",
      evidence: [
        {
          locator: packet.citationChecks[0]!.citation.locator,
          quote: "The outbox retries failed deliveries.",
          supports: true,
          why: "The source states the retry behavior.",
        },
      ],
      premises: [],
      conflicts: [],
    };
  },
};

const conflictVerifier: ConflictVerifier = {
  async find(_target, candidates) {
    const candidate = candidates[0]!;
    return {
      findings: [
        {
          candidateID: candidate.node.id,
          relation: "contradicts",
          reason: "The delivery paths cannot both be true.",
          evidence: [
            {
              locator: candidate.citationChecks[0]!.citation.locator,
              quote: "Billing publishes directly to the provider.",
              why: "This conflicts with the outbox path.",
            },
          ],
        },
      ],
      cacheable: true,
    };
  },
};

test("support eval reports binary accuracy and grounded evidence", async () => {
  const result = await runSupportEval(supportCases, supportVerifier, {
    readSources: true,
  });
  assert.equal(result.metrics.total, 1);
  assert.equal(result.metrics.passed, 1);
  assert.equal(result.metrics.accuracy, 1);
  assert.equal(result.metrics.falseSupport, 0);
  assert.equal(result.metrics.evidenceGrounded, 1);
  assert.equal(result.metrics.evidenceMatched, 1);
  assert.equal(result.results[0]?.actual, "supported");
});

test("support eval flags ungrounded evidence without using confidence", async () => {
  const result = await runSupportEval(
    supportCases,
    {
      async verify() {
        return {
          verdict: "supported",
          suggestedAction: "confirm",
          reason: "Looks plausible.",
          evidence: [
            {
              locator: "docs/source.md",
              quote: "This quote is not in the source.",
              supports: true,
            },
          ],
          premises: [],
          conflicts: [],
        };
      },
    },
    { readSources: true },
  );
  assert.equal(result.metrics.passed, 1);
  assert.equal(result.metrics.evidenceGrounded, 0);
  assert.equal(result.metrics.evidenceMatched, 0);
});

test("conflict eval reports pair metrics, candidate recall, and evidence grounding", async () => {
  const result = await runConflictEval(conflictCases, conflictVerifier, {
    readSources: true,
    candidatesPerClaim: 3,
  });
  assert.equal(result.metrics.total, 1);
  assert.equal(result.metrics.passed, 1);
  assert.equal(result.metrics.truePositives, 1);
  assert.equal(result.metrics.falsePositives, 0);
  assert.equal(result.metrics.falseNegatives, 0);
  assert.equal(result.metrics.precision, 1);
  assert.equal(result.metrics.recall, 1);
  assert.equal(result.metrics.candidateRecall, 1);
  assert.equal(result.metrics.evidenceGrounded, 1);
  assert.equal(result.metrics.evidenceMatched, 1);
});

test("bundled eval fixtures are valid JSONL", () => {
  assert.ok(loadSupportCases("evals/support.jsonl").length >= 8);
  assert.ok(loadConflictCases("evals/conflicts.jsonl").length >= 6);
});
