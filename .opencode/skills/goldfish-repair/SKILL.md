---
name: Goldfish Repair
description: Inspect and repair stale, disputed, rejected, or unsupported goldfish claims with versioned corrections. Use when the user invokes /goldfish-repair, when memory_health or memory_review shows a claim that needs correction, or after verification reports stale, contradicted, or insufficient evidence.
metadata:
  opencode/autoinvoke: true
---

# Goldfish repair

Repair is a human-approved, versioned correction. It is not an automatic
rewrite. The main agent orchestrates the repair; there is no background worker.

## Guard

- Call `memory_repair` and show the claim, evidence, conflicts, and suggested
  actions first.
- Do not edit memory until the user chooses an action.
- Do not auto-resolve a conflict, auto-verify, or silently archive.
- Prefer the smallest repair that makes the claim honest.

## Repair tiers

| Tier | Scope | Examples |
|---|---|---|
| 0 — metadata | title, scope, tags, links | `memory_admin.update` |
| 1 — agent content | citations and body revision | `memory_admin.cite`, `memory_remember` |
| 2 — human authority | ratification, rejection, replacement, conflict decision | `memory_admin.confirm`, `memory_admin.reject`, `memory_admin.conflict` |
| 3 — incident | malicious or unsafe content | `memory_admin.archive` |

The repair packet recommends the highest tier required by its actions.

## Workflow

1. Call `memory_repair` with the claim ID.
2. Read the current cited sources yourself. Do not trust only the stored excerpt.
3. Call `memory_get`, `memory_neighbors`, and `memory_conflicts` when the packet
   shows relationships or conflicts that matter.
4. Present the suggested actions and wait for the user to choose.
5. Apply exactly one action.
6. Re-run `memory_verify` on the new version when the action changed content or
   evidence.
7. Call `memory_review` and report what remains.

## Applying actions

- **update_metadata**
  Use `memory_admin.update` for title, scope, or tags. The node ID stays stable.
- **recite**
  Add current citations with `memory_admin.cite`, then confirm as `cited` if the
  source supports the claim.
- **revise**
  Use `memory_remember` with the same kind and title, the corrected body and
  citations, a `reason`, and repair metadata:
  `{ repairTier, repairAction, repairedAt, previousStatus, previousVerificationState }`.
  This creates a new version and keeps the claim ID.
- **replace**
  Use `memory_remember` with a new title and `supersedes: "<old-id>"` when the old
  claim should no longer be canonical. The old claim becomes superseded.
- **confirm_cited**
  Use `memory_admin.confirm as="cited"` only when fresh citations support the
  claim.
- **confirm_derived**
  Use `memory_admin.confirm as="derived"` only when the premises are sound and
  acyclic.
- **confirm_verified**
  Use `memory_admin.confirm as="verified"` only on explicit human instruction.
  It records a human citation and is permission-gated.
- **reject**
  Use `memory_admin.reject` with the reason. The claim remains in history but
  stops auto-injecting.
- **archive**
  Use `memory_admin.archive` for malicious or unsafe content. Ask first.
- **leave_for_review**
  Do not write. Report what human decision is needed.

## Conflicts

A repair may make a conflict proposal stale because the claim version changed.
That does not resolve the conflict. The user still confirms or dismisses the
proposal with `memory_admin.conflict`. Do not dismiss a proposal just because a
claim was revised.

## Commands

- `/goldfish-repair [target]` — inspect and repair a claim.
- `/goldfish-review [scope]` — show the review queue.
- `/goldfish-verify [target]` — verify evidence.
- `/goldfish-ratify [target]` — explicit human confirmation.
- `/goldfish-reject [target]` — explicit rejection.

## Safety

- Never delete history.
- Never overwrite a claim without a new version.
- Never auto-resolve a conflict.
- Never apply a repair the user did not approve.
- Never use `verified` without human, test, or commit evidence.
- Keep the final report concise: action, tier, old version, new version, result.
