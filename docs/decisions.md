# Project memory decisions

This file is both human documentation and a citation source for the project
memory seed. It records the durable decisions behind the `monkey-memory`
extension.

## Local-first storage

The live knowledge store is a SQLite database in the OpenCode data directory,
scoped by a stable project key. SQLite with FTS5 is enough for project-scale
retrieval, and it avoids running a separate graph database or vector service.
Curated knowledge can be exported as a deterministic JSONL bundle for review,
backup, or sharing. The SQLite file itself is never committed.

## Optimistic writes, earned injection

Agents may write claims freely, but auto-injection is earned. `verified` and
`cited` claims may be injected automatically in normal scopes. `inferred`
claims are queryable through explicit recall but must be confirmed by a human
or an independent, rejection-leaning verifier before they can be auto-injected.
`disputed` and `stale` claims require explicit recall and are shown with a
warning. This preserves broad contribution without letting every hypothesis
enter the ambient context.

## Claims and entities are separate

The graph stores entity nodes (components, concepts, documents, sources,
sessions) and claim nodes (facts, decisions, gotchas, patterns, runbooks).
Edges connect claims to entities and sources. A claim can carry multiple
citations, can be contested by another claim, and can be superseded without
losing its history. This is why the store does not model "observations" as a
flat list attached to an entity.

## Verification is independent and rejection-leaning

Verification reads the cited sources rather than trusting the claim's own
wording. The verifier defaults to reject, requires direct evidence, quotes the
supporting text, and refuses circular citations. A confirmed inferred claim is
promoted to `cited` when the evidence is a source, or `verified` when a human
or reproducible test confirms it. A material revision resets verification.

## Audit sampling

Auto-inject-eligible claims are audited with a 3% uniform random sample and a
7% risk-weighted sample. The uniform sample estimates the overall defect rate;
the risk sample prioritizes new authors, low-confidence claims, frequently
injected claims, recent revisions, strict scopes, and prior disputes. Every
write gets deterministic citation and content checks. Disputes, stale citations,
and verification failures trigger audits directly.

## Per-scope strict mode

The default policy allows `verified` and `cited` claims to auto-inject. Strict
scopes such as `auth/**`, `payments/**`, `infra/prod/**`, and migrations require
`verified` evidence or explicit recall. A strict scope may also raise its audit
rate. If scope inference is uncertain, the stricter policy wins.

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
conflict edges, audit records, injection logs, and export. It has no OpenCode
imports, so the CLI, tests, and plugin all use the same core through a small
interface. The plugin is a thin adapter: tools, hooks, permissions, and runtime
paths live there; storage and recall policy live in the core.

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
