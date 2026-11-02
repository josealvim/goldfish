import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_POLICY,
  effectiveAllowedBasis,
  isAutoInjectEligible,
  parseInjectionPolicy,
} from "../src/core/policy.ts";
import type { Basis, MemoryNode, NodeStatus, VerificationState } from "../src/core/types.ts";

function node(
  overrides: Partial<{
    scope: string[];
    basis: Basis;
    status: NodeStatus;
    verificationState: VerificationState;
  }> = {},
): Pick<MemoryNode, "scope" | "basis" | "status" | "verificationState"> {
  return {
    scope: [],
    basis: "cited",
    status: "active",
    verificationState: "not_required",
    ...overrides,
  };
}

test("default policy allows cited and verified, not inferred", () => {
  assert.deepEqual(effectiveAllowedBasis(node({ basis: "verified" }), []), ["verified", "cited"]);
  assert.deepEqual(effectiveAllowedBasis(node({ basis: "cited" }), []), ["verified", "cited"]);
  assert.equal(isAutoInjectEligible(node({ basis: "verified" })), true);
  assert.equal(isAutoInjectEligible(node({ basis: "cited" })), true);
  assert.equal(isAutoInjectEligible(node({ basis: "inferred", verificationState: "unverified" })), false);
});

test("strict scopes apply from either the claim scope or the current task scope", () => {
  assert.deepEqual(effectiveAllowedBasis(node({ basis: "cited", scope: ["auth/session.ts"] }), []), [
    "verified",
  ]);
  assert.deepEqual(effectiveAllowedBasis(node({ basis: "cited", scope: [] }), ["auth/session.ts"]), [
    "verified",
  ]);
  assert.equal(
    isAutoInjectEligible(node({ basis: "cited", scope: ["auth/session.ts"] }), ["auth/session.ts"]),
    false,
  );
  assert.equal(
    isAutoInjectEligible(node({ basis: "verified", scope: ["auth/session.ts"] }), ["auth/session.ts"]),
    true,
  );
});

test("the most restrictive matching strict rule wins", () => {
  const claim = node({ basis: "verified", scope: ["auth/migrations/001.ts"] });
  assert.deepEqual(effectiveAllowedBasis(claim, ["auth/migrations/001.ts"]), []);
  assert.equal(isAutoInjectEligible(claim, ["auth/migrations/001.ts"]), false);
});

test("rejected, needs-human, disputed, and stale claims are never auto-injected", () => {
  assert.equal(
    isAutoInjectEligible(node({ basis: "cited", verificationState: "rejected" })),
    false,
  );
  assert.equal(
    isAutoInjectEligible(node({ basis: "cited", verificationState: "needs_human" })),
    false,
  );
  assert.equal(isAutoInjectEligible(node({ basis: "cited", status: "disputed" })), false);
  assert.equal(isAutoInjectEligible(node({ basis: "cited", status: "stale" })), false);
  assert.equal(isAutoInjectEligible(node({ basis: "verified", status: "superseded" })), false);
});

test("parseInjectionPolicy falls back safely and accepts custom scopes", () => {
  assert.deepEqual(parseInjectionPolicy(undefined), DEFAULT_POLICY);
  assert.deepEqual(parseInjectionPolicy({ strict: "not-an-array" }).strict, DEFAULT_POLICY.strict);

  const custom = parseInjectionPolicy({
    defaultAllowed: ["verified"],
    strict: [{ pattern: "billing/**", allowed: [] }],
  });
  assert.deepEqual(custom.defaultAllowed, ["verified"]);
  assert.deepEqual(custom.strict, [{ pattern: "billing/**", allowed: [] }]);
  assert.deepEqual(effectiveAllowedBasis(node({ basis: "verified", scope: ["billing/x.ts"] }), [], custom), []);
});
