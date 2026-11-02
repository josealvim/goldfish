import type { Basis, MemoryNode } from "./types.ts";
import { anyScopeMatches } from "./glob.ts";

export interface StrictScopeRule {
  pattern: string;
  allowed: Basis[];
}

export interface InjectionPolicy {
  defaultAllowed: Basis[];
  strict: StrictScopeRule[];
  allowInferredAfterConfirmation: boolean;
}

export const DEFAULT_POLICY: InjectionPolicy = {
  defaultAllowed: ["verified", "cited", "derived"],
  strict: [
    { pattern: "auth/**", allowed: ["verified"] },
    { pattern: "**/auth/**", allowed: ["verified"] },
    { pattern: "payments/**", allowed: ["verified"] },
    { pattern: "**/payments/**", allowed: ["verified"] },
    { pattern: "infra/prod/**", allowed: ["verified"] },
    { pattern: "**/migrations/**", allowed: [] },
  ],
  allowInferredAfterConfirmation: true,
};

function rankAllowed(allowed: readonly Basis[]): number {
  const set = new Set(allowed);
  if (set.size === 0) return 0;
  if (set.size === 1 && set.has("verified")) return 1;
  if (set.size === 2 && set.has("verified") && set.has("cited")) return 2;
  if (set.size === 3 && set.has("verified") && set.has("cited") && set.has("derived")) return 3;
  return 4;
}

/**
 * The effective policy is the most restrictive policy whose strict pattern
 * matches either the claim's scope or the current task scope.
 */
export function effectiveAllowedBasis(
  node: Pick<MemoryNode, "scope" | "basis">,
  currentScope: readonly string[],
  policy: InjectionPolicy = DEFAULT_POLICY,
): Basis[] {
  let allowed = policy.defaultAllowed;
  let rank = rankAllowed(allowed);

  for (const rule of policy.strict) {
    const claimMatches = anyScopeMatches([rule.pattern], node.scope);
    const taskMatches = anyScopeMatches([rule.pattern], currentScope);
    if (!claimMatches && !taskMatches) continue;
    const nextRank = rankAllowed(rule.allowed);
    if (nextRank < rank) {
      allowed = rule.allowed;
      rank = nextRank;
    }
  }

  return allowed;
}

export function isAutoInjectEligible(
  node: Pick<MemoryNode, "status" | "basis" | "verificationState" | "scope">,
  currentScope: readonly string[] = [],
  policy: InjectionPolicy = DEFAULT_POLICY,
): boolean {
  if (node.status !== "active") return false;
  if (node.verificationState === "rejected" || node.verificationState === "needs_human") return false;
  // Inferred claims are queryable, but they must be promoted to cited or
  // verified before they can be injected automatically.
  if (node.basis === "inferred") return false;
  // Derived claims are trusted only after graph verification confirms that all
  // premises are sound.
  if (node.basis === "derived" && node.verificationState !== "confirmed") return false;
  return effectiveAllowedBasis(node, currentScope, policy).includes(node.basis);
}

export function parseInjectionPolicy(value: unknown): InjectionPolicy {
  if (!value || typeof value !== "object") return DEFAULT_POLICY;
  const input = value as Partial<InjectionPolicy>;
  const defaultAllowed = Array.isArray(input.defaultAllowed)
    ? input.defaultAllowed.filter(
        (basis): basis is Basis => basis === "verified" || basis === "cited" || basis === "derived",
      )
    : DEFAULT_POLICY.defaultAllowed;
  const strict = Array.isArray(input.strict)
    ? input.strict
        .filter((rule): rule is StrictScopeRule => Boolean(rule && typeof rule.pattern === "string"))
        .map((rule) => {
          const allowed: Basis[] = Array.isArray(rule.allowed)
            ? rule.allowed.filter(
                (basis): basis is Basis =>
                  basis === "verified" || basis === "cited" || basis === "derived",
              )
            : ["verified"];
          return { pattern: rule.pattern, allowed };
        })
    : DEFAULT_POLICY.strict;
  return {
    defaultAllowed,
    strict,
    allowInferredAfterConfirmation: input.allowInferredAfterConfirmation ?? true,
  };
}
