# Project memory decisions

This file is both human documentation and a citation source for the project
memory seed. It records the durable decisions behind the `goldfish`
extension.

## Local-first storage

The live knowledge store is a SQLite database in the OpenCode data directory,
scoped by a stable project key. SQLite with FTS5 is enough for project-scale
retrieval, and it avoids running a separate graph database or vector service.
Curated knowledge can be exported as a deterministic JSONL bundle for review,
backup, or sharing. The SQLite file itself is never committed.

## Optimistic writes, earned injection

Agents may write claims freely, but auto-injection is earned. `verified`,
`cited`, and confirmed `derived` claims may be injected automatically in normal
scopes. `inferred` and unconfirmed `derived` claims are queryable through
explicit recall but must be confirmed before they can be auto-injected.
`disputed` and `stale` claims require explicit recall and are shown with a
warning. This preserves broad contribution without letting every hypothesis
enter the ambient context.

The basis ladder is `inferred < derived < cited < verified`. A derived claim
must have cited or verified premises linked with `derived_from`. The graph
verifier checks premise soundness and rejects cycles before the claim is
eligible for injection.

## Claims and entities are separate

The graph stores entity nodes (components, concepts, documents, sources,
sessions) and claim nodes (facts, decisions, gotchas, patterns, runbooks).
Edges connect claims to entities and sources. A claim can carry multiple
citations, can be contested by another claim, and can be superseded without
losing its history. This is why the store does not model "observations" as a
flat list attached to an entity.

## Verification is independent and rejection-leaning

Verification reads the cited sources rather than trusting the claim's own
wording. It runs in layers. Deterministic checks cover citation existence and
content hashes, conflict edges, `derived_from` cycles, premise soundness, and
scope sanity. A semantic verifier runs only when deterministic checks pass but
cannot decide support. The verifier defaults to reject, requires direct
evidence, quotes the supporting text, and refuses circular citations.

Semantic verification sends a bounded window of the current source, not just the
excerpt stored at write time. Snapshots are anchored near the cited excerpt,
capped per citation and per packet, and skipped for binary, generated, lockfile,
or sensitive paths. Obvious secrets are redacted, and instruction-like text is
flagged. Source windows are untrusted data. Because a remote verifier model
would receive source text, reading is configurable and can be disabled for
privacy; the defaults are explicit rather than hidden.

A confirmed inferred claim is promoted to `cited` when a source supports it, or
`derived` when its premises are sound. The verifier never promotes to
`verified`; only a human, reproducible test, or commit evidence can do that. The
verifier may attach a ratification suggestion, which appears in the review
queue and health report. Semantic verdicts are cached by an input hash that
covers the claim version, citations, premises, conflicts, and citation
freshness. A material revision resets verification.

## Human review actions are explicit and versioned

A model may suggest a verdict or a ratification, but a human decision is a
separate write. `memory_admin.confirm` accepts `cited`, `derived`, or
`verified`. Confirming as `cited` requires at least one citation; confirming as
`derived` requires a `derived_from` premise; confirming as `verified` requires
explicit human instruction, is permission-gated, and records a human citation
with the reason. Confirmation clears the ratification suggestion.

`memory_admin.reject` keeps the claim and its history available through
`memory_get` but sets its verification state to rejected and removes it from
auto-injection. Confirmation and rejection both create a new node version and
carry the existing citations forward. This closes the review loop without
letting a verifier or an agent ratify itself.

## Audit sampling

Auto-inject-eligible claims are audited with a 3% uniform random sample and a
7% risk-weighted sample. The uniform sample estimates the overall defect rate;
the risk sample prioritizes new authors, low-confidence claims, frequently
injected claims, recent revisions, strict scopes, and prior disputes. Every
write gets deterministic citation and content checks. Disputes, stale citations,
and verification failures trigger audits directly.

Auditing is command-first: `memory_audit` can preview candidates, run a
bounded sample, or record an external outcome. The semantic model is called only
for sampled or explicitly verified claims, never for every claim. A claim is
skipped for 30 days after an audit of the same version, so repeated runs do not
crowd out unaudited claims; a material revision resets the cooldown. Background
audit and repair workers are deferred until the command-first loop has evidence
that they are worth the cost and complexity.

## Discover conflicts, but confirm them separately

Conflict discovery retrieves related claims through text, graph, scope, and tag
signals, then compares the target against a bounded candidate set using current
source windows. The model may only return candidate IDs it was given. A
discovery result is stored as a proposal, not as an edge or status change. It
never marks either claim `disputed`, because a model-detected clash can be a
false positive.

Proposals deduplicate by a canonical pair and record both claim versions. A
material revision makes the proposal stale. A dismissed proposal is not
re-proposed until one claim version changes. Confirming a proposal adds the
`contradicts` edge and marks both sides `disputed`; dismissing it leaves both
claims untouched. This separates cheap discovery from high-consequence
resolution.

## Conflicts leave both sides disputed

A conflict is evidence that at least one claim is wrong, not a vote. Once a
conflict is confirmed, both claims are marked `disputed`, both lose
auto-injection, and the `contradicts` edge is preserved. The system does not
auto-resolve the conflict, auto-delete a side, or silently choose the newer
claim. A human resolves it by adding evidence, revising one side with
`supersedes`, or archiving the wrong claim. This prevents a confident verifier
or a newer write from erasing a real disagreement.

## Per-scope strict mode

The default policy allows `verified`, `cited`, and confirmed `derived` claims to
auto-inject. Strict scopes such as `auth/**`, `payments/**`, `infra/prod/**`, and
migrations require `verified` evidence or explicit recall. A strict scope may
also raise its audit rate. If scope inference is uncertain, the stricter policy
wins.

## Repair is versioned

Repairs never delete history. A correction creates a new version, a revert
creates a new version that restores the previous content, and a stale or
disputed claim is removed from auto-injection immediately. Repairs are Tier 0
(metadata), Tier 1 (agent-assisted content), Tier 2 (human/high-authority), or
Tier 3 (incident response). A repair that lands during a live session can send a
synthetic correction message.

## Ingestion order

The first version captures decisions, gotchas, patterns, and component
relationships. Structural facts come from deterministic adapters: the repository
map, docs headings, Git/PR metadata, and session metadata. Meaning comes from
agent-assisted ingestion: a skill or command reads the source and proposes
claims with citations. The adapter order is manual/docs, then the repository
map, then Git/PR, then opt-in session learnings.

## Core module boundary

The `MemoryStore` owns persistence, retrieval, write validation, deduplication,
conflict edges and proposals, audit records, citation freshness and source
snapshots, injection logs, and export. It has no OpenCode imports, so the CLI,
tests, and plugin all use the same core through a small interface. The plugin is
a thin adapter: tools, hooks, permissions, model calls, and runtime paths live
there; storage and policy live in the core.

## SQLite runtime adapter

The plugin runs in OpenCode's Bun server and uses `bun:sqlite`. The CLI and tests
run on Node and use Node's built-in `node:sqlite`. `better-sqlite3` is not used
because Bun does not support it. The storage adapter tries `bun:sqlite` first and
falls back to `node:sqlite`, which keeps the core testable outside the OpenCode
server.

## OpenCode integration

The extension is an OpenCode plugin. Tools are registered through
`ctx.tool.transform`, automatic recall runs from the prompt hook, and the
recalled block is persisted as a session instruction entry when available. The
context hook is a fallback for runtimes without session instruction entries.
`ctx.permission.assert` gates writes. The plugin runs in the OpenCode server and
uses `bun:sqlite`; the CLI and tests use Node's built-in `node:sqlite`.
