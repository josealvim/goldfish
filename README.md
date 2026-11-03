# goldfish

Local-first project memory for OpenCode agents.

`goldfish` gives agents a small, queryable knowledge base of project
decisions, gotchas, patterns, components, documents, and past learnings. Agents
retrieve evidence cards with citations instead of reading whole files, and they
can contribute durable claims back to the project.

The design is **optimistic writes, earned injection**:

- Every valid claim is stored and queryable immediately.
- `verified`, `cited`, and confirmed `derived` claims can be auto-injected in
  normal scopes.
- `inferred` and unconfirmed `derived` claims are queryable through explicit
  recall but must be confirmed by a human or an independent, rejection-leaning
  verifier before automatic injection.
- `disputed` and `stale` claims require explicit recall and are shown with a
  warning. Confirmed conflicts leave both sides disputed and are not
  auto-resolved; discovered conflicts remain proposals until a human confirms.
- Memory is evidence, not authority. The agent verifies against current sources
  before editing.

Verification is layered: deterministic citation and graph checks run first, a
semantic verifier reads bounded current-source windows only when needed,
conflict discovery compares related claims, audits are sampled, and human review
handles ambiguity and ratification. Only a human, a reproducible test, or a
commit can make a claim `verified`; a model may suggest ratification but cannot
grant it.

This repository contains the core store, CLI, OpenCode plugin, skills, seed
data, and tests. The verifier, conflict discovery, audit runner, and review
queue are command-first; background workers, automated repair, and structural
ingestion adapters are the next slices.

## Install from GitHub

No npm publish is required. The package is installed directly from Git.

### OpenCode Git installer

```sh
opencode plugin add github:josealvim/goldfish

# Pin a release tag
opencode plugin add github:josealvim/goldfish#v0.13.1
```

Or clone the repository and run the installer:

```sh
git clone https://github.com/josealvim/goldfish.git
cd goldfish
./install.sh
```

### Manual Git install

```sh
git clone https://github.com/josealvim/goldfish.git \
  ~/.config/opencode/plugins/goldfish
```

Add the cloned directory to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/home/<you>/.config/opencode/plugins/goldfish"]
}
```

For a project-local install, clone into `.opencode/plugins/goldfish` and
add `"./.opencode/plugins/goldfish"` to that project's config.

If a project already has the local development wrapper at
`.opencode/plugins/project-memory` configured, do not also install the global
Git plugin in that same project. OpenCode will list both copies. Use one or the
other: the local wrapper for development, the Git install for consumption.

The plugin registers the bundled skills from `.opencode/skills/*/SKILL.md`
itself, so no project-local skill is required. The directory name is the skill
ID; `name`, `description`, and `opencode/autoinvoke` come from the frontmatter.
If a discovered skill file is unreadable or malformed, plugin setup fails with
the file path instead of loading embedded fallback text. The test suite asserts
the expected bundled skill set so a missing directory is caught before release.
A plain clone works without `npm install`: OpenCode provides `@opencode/plugin`,
and the plugin entry is ordinary TypeScript. Restart OpenCode or run `/reload`,
then verify with:

```sh
opencode plugin list
```

The plugin uses one SQLite database per project:

```text
~/.local/share/opencode/projects/<project-id>/memory.sqlite
```

Git projects get a stable project ID stored in the worktree's private git
directory; legacy databases used a path-derived key. The ID file is
`<git-dir>/goldfish/projects/<relative-path-hash>/id`; it is local metadata
inside `.git` and is never committed. New projects create it automatically on
first open; existing path-keyed databases keep using the legacy key until you run
`memory stabilize`. Override the database path with `--db` or `GOLDFISH_DB`;
an explicit path bypasses stable identity selection.

### Moving or renaming a project

A normal filesystem move or rename preserves the stable Git project ID, so the
same database keeps serving the project. A fresh `git clone` gets a new ID and
starts with a new database; this keeps separate working copies independent.
Copying a repository including its `.git` directory also copies the identity.
Worktrees get independent IDs because the ID lives in each worktree's private
git directory.

If you already have a path-keyed database from an older goldfish version, run:

```sh
npm run memory -- id          # show the stable ID, legacy key, and database paths
npm run memory -- stabilize   # create the stable ID and schedule adoption
```

Then restart OpenCode (or run `/reload`). The plugin adopts the legacy database
on startup, before the session writes anything. The legacy database is left in
place as a backup. `memory stabilize --now` copies immediately; use it with
OpenCode closed, or restart OpenCode immediately afterward. If `memory id`
warns that the legacy database has newer updates, export it explicitly and
import it into the stable database rather than replacing files.

`memory projects` lists known project databases, including inactive legacy
databases. Run identity commands from the same project root OpenCode uses, or
pass `--project <dir>` when in doubt. Projects without a Git worktree keep using
a path-derived key; use the plugin `dbPath` option or `GOLDFISH_DB` when those
must be move-safe.

## Develop in this repository

The local wrapper is `.opencode/plugins/project-memory`; the skill is
`.opencode/skills/project-memory/SKILL.md`.

```sh
npm install
npm run seed
npm run memory -- recall "how does injection work?"
```

## Agent tools

| Tool | Purpose |
|---|---|
| `memory_recall` | Search project memory. Returns compact evidence cards with citations, scope, confidence, and related IDs. |
| `memory_remember` | Propose a durable claim with citations and optional graph links. Deduplicates and detects conflicts. |
| `memory_get` | Read a node in full, including citations, relationships, and version history. |
| `memory_neighbors` | Walk the knowledge graph one or two hops. |
| `memory_status` | Show memory coverage, project identity, database path, and whether onboarding is recommended. |
| `memory_export_graph` | Export a deterministic JSON, GraphML, DOT, or offline HTML graph file. |
| `memory_scan` | Read-only structural scan: layout, manifests, scripts, candidate components, entry points, docs headings, CI, and Git metadata. |
| `memory_learn` | Read a bounded, redacted digest of user and assistant session text. Read-only. |
| `memory_stage_learning` | Stage the full session-learning candidate list in a local review file without writing memory. |
| `memory_list` | List nodes by kind, status, basis, scope, or tag, with citation and edge counts. |
| `memory_health` | Show uncited, stale, disputed, orphaned, low-confidence, backlog, ratification, and renamed-ID diagnostics. |
| `memory_verify` | Verify inferred/derived claims against bounded current-source windows with deterministic checks plus an optional semantic verifier. Never promotes to `verified`; may suggest ratification. |
| `memory_conflicts` | Discover likely conflicts with related claims and store proposals for review. Never disputes a claim automatically. |
| `memory_review` | Show the review queue, including proposed conflicts. |
| `memory_audit` | Preview or run a sampled audit; record an external outcome. Conflicts are never auto-resolved. |
| `memory_eval` | Run the support/conflict evaluation suites against the configured verifier using temporary stores. |
| `memory_repair` | Inspect a claim for versioned repair: evidence freshness, conflicts, neighbors, history, repair tier, and actions. Read-only. |

`memory_admin.confirm` and `memory_admin.reject` complete the review loop; the
`/goldfish-ratify` and `/goldfish-reject` commands provide explicit human entry
points. Confirm supports `cited`, `derived`, and `verified`. Confirming as
`verified` requires explicit human instruction, is permission-gated, records a
human citation, and clears the ratification suggestion. Rejection keeps the
claim in history but removes it from auto-injection.

`memory_admin.conflict` confirms or dismisses a proposed conflict. Confirming
adds the `contradicts` edge and marks both sides disputed; dismissing leaves
both claims untouched.

The `project-memory` skill teaches the daily workflow. The
`goldfish-onboarding` skill bootstraps a new project. The
`goldfish-verification` skill covers verification, conflicts, audit, evaluation,
and human review actions. The `goldfish-repair` skill covers versioned repairs.
The `goldfish-learn` skill covers explicit session learning.
`AGENTS.md` carries the short policy so it applies even when a skill is not
loaded.

## Onboarding a new project

A freshly installed project starts with an empty knowledge base. Run:

```text
/goldfish-onboard
```

or scope it:

```text
/goldfish-onboard packages/billing
```

The onboarding workflow:

- checks `memory_status` and existing memory first
- calls `memory_scan` to map the repository without writing memory
- reads at most 12 files / 4,000 lines
- writes 10–15 cited nodes: one overview, 3–5 components, 3–5
  decisions/patterns, and 3–5 gotchas/runbooks
- uses the fixed `concept/project-overview` ID
- marks source-backed claims `cited`, guesses `inferred`, and never uses
  `verified` without a human, test, or commit
- reports coverage and asks before expanding the first pass

If memory is empty and you did not ask to onboard, the model should suggest
`/goldfish-onboard` rather than writing unsolicited claims.

## Project scan

`memory_scan` is a read-only structural scan. It reports:

- bounded file counts, extensions, and sample paths
- package manifests, workspaces, scripts, and candidate components
- entry points
- docs headings
- CI config
- Git branch, HEAD, dirty state, recent commits, and tags
- skipped sensitive/generated paths

It does not read arbitrary source bodies, write memory, or call a model. Use it
before onboarding, repair, or targeted reads. `/goldfish-scan [scope]` exposes
the same scan.

## Session learning

Session learning is explicit and human-approved. It never runs from a hook.

```text
/goldfish-learn
/goldfish-learn ses_abc123
```

`memory_learn` returns a bounded, redacted digest of user and assistant text. It
excludes reasoning, system, synthetic, and tool content. The agent extracts
candidates, deduplicates them against memory, and shows at most five at a time
with stable IDs.

If there are more than five candidates, `memory_stage_learning` writes the full
list to:

```text
.opencode/memory/session-learning/<session-id>.jsonl
```

The staging file is a local review artifact, not memory. It is never
auto-injected. Session-only claims default to `inferred`; concrete file, test, or
commit citations take precedence. Only approved candidates are written with
`memory_remember`.

## Maintenance

Use `memory_list` to enumerate nodes and `memory_health` to find work:

- uncited active nodes
- stale or disputed claims
- orphaned nodes with no edges
- low-confidence claims
- verification and audit backlogs
- proposed conflicts awaiting review
- suggested ratifications to `verified`
- nodes whose ID slug no longer matches their title
- overview presence and linkage
- citation coverage

Use the review and verification loop before relying on uncertain claims:

```text
memory_review
memory_verify { "ids": ["decision/example"] }
memory_conflicts { "ids": ["decision/example"] }
memory_audit { "mode": "candidates", "limit": 10 }
memory_audit { "mode": "run", "limit": 10 }
memory_eval { "suite": "all", "limit": 25 }
memory_repair { "id": "decision/example" }
memory_admin.confirm { "id": "decision/example", "as": "verified", "reason": "Human checked the source." }
memory_admin.reject { "id": "gotcha/example", "reason": "The current source contradicts this." }
```

`memory_verify` runs deterministic checks first: citation existence and content
hashes, conflict edges, `derived_from` cycles, premise soundness, and scope
sanity. It calls the semantic verifier only when the deterministic layer cannot
settle the claim. The verifier reads a bounded window of the current source
around each cited excerpt, not just the stored excerpt. Source windows are
redacted, capped, and skipped for binary, generated, lockfile, and sensitive
paths. Semantic verdicts are cached by an input hash, so re-running on unchanged
evidence does not spend another model call.

The semantic verifier may promote an inferred claim to `cited` or `derived`,
mark it stale, dispute both sides of an existing conflict, archive malicious
content, or queue it for human review. It never promotes to `verified`. It may
attach a ratification suggestion, which appears in `memory_review` and
`memory_health`.

Model verdicts are binary decisions with a short reason and evidence list. The
verifier is not asked for confidence scores or thresholds. Acceptance is based
on whether the decision is supported by grounded evidence, not on a
persuasive-looking number.

`memory_conflicts` retrieves related claims through text, graph, scope, and tag
signals, then compares bounded source windows. It stores proposals only: it
never marks a claim disputed or creates a `contradicts` edge. A proposal records
both claim versions, so a material revision makes it stale. Dismissed proposals
are not re-proposed until a claim changes. Confirm or dismiss with
`memory_admin.conflict` after explicit human review.

The plugin also registers the corresponding commands:

```text
/goldfish-scan [scope]       map the repository without writing memory
/goldfish-graph [format]     export a deterministic graph or offline explorer
/goldfish-learn [session]    digest a session and propose durable candidates
/goldfish-review [scope]     show the review queue
/goldfish-verify [target]    verify up to 5 claims
/goldfish-audit [target]     sample and audit eligible claims
/goldfish-conflicts [target] discover and review likely conflicts
/goldfish-eval [suite]       run verification/conflict evaluation suites
/goldfish-repair [target]    inspect and apply a versioned correction
/goldfish-ratify [target]    review and confirm a claim
/goldfish-reject [target]    reject a reviewed claim
```

Precise changes use the `memory_admin` namespace through Code Mode:

```text
memory_admin.cite      add citations without rewriting the claim
memory_admin.link      add or reactivate a typed edge
memory_admin.unlink    retire an edge without deleting history
memory_admin.update    change title, scope, or tags; the ID stays stable
memory_admin.confirm   confirm as cited, derived, or verified after review
memory_admin.reject    reject a claim and remove it from auto-injection
memory_admin.archive   soft-delete; history remains in memory_get
memory_admin.conflict  confirm or dismiss a proposed conflict
```

Use `memory_remember` for semantic revisions. `memory_admin` is for maintenance,
not for rewriting claims.

## What happens on a prompt

1. The `prompt` hook extracts a query from the user message and attached file
   paths.
2. The store runs lexical recall with graph expansion, filtered to claims that
   pass the injection policy.
3. A compact `<project_memory>` block is written as a session instruction entry
   when the runtime supports it. The `context` hook is a fallback for runtimes
   without entries.
4. The injected node IDs, session, and message are logged in the `injections`
   table.
5. If the agent calls `memory_recall` explicitly, the tool returns a broader
   result, including inferred claims by default.

Auto-recall skips short acknowledgements, slash commands, and prompts that
explicitly ask the agent to call a memory tool.

## CLI

```sh
# Recall
npm run memory -- recall "billing outbox" --scope services/billing --limit 5

# Store a claim from JSON
npm run memory -- remember --json ./claim.json

# Inspect
npm run memory -- id
npm run memory -- projects
npm run memory -- get decision/use-sqlite-with-fts5-for-project-memory
npm run memory -- neighbors decision/use-sqlite-with-fts5-for-project-memory --depth 2
npm run memory -- list --kind decision --status active --limit 20
npm run memory -- health
npm run memory -- stats

# Stabilize a legacy database after upgrading
npm run memory -- stabilize
npm run memory -- stabilize --now   # with OpenCode closed

# Review and quality loop
npm run memory -- review
npm run memory -- confirm gotcha/example --as derived
npm run memory -- reject gotcha/example --reason "Contradicted by the current worker code."
npm run memory -- revalidate
npm run memory -- audit --uniform 0.03 --risk 0.07
npm run memory -- audit-record gotcha/example --outcome supported --trigger manual

# Share or back up
npm run memory -- export .opencode/memory/export
npm run memory -- import .opencode/memory/export

# Graph exports
npm run memory -- graph --format json --out .opencode/memory/graph.json
npm run memory -- graph --format graphml --out .opencode/memory/graph.graphml
npm run memory -- graph --format dot --out .opencode/memory/graph.dot
npm run memory -- graph --format html --out .opencode/memory/graph.html

# Evaluate recall against the local suite
npm run memory -- eval
```

`remember --json` accepts an inline JSON object or a file path. `seed` accepts a
JSONL file of proposals; see `test/fixtures/seed.jsonl`. CLI `eval` measures
recall only.

## Graph exports

`graph` writes a deterministic graph from the same SQLite store as the rest of
goldfish. It supports JSON, GraphML, DOT, and a fully offline single-file HTML
explorer. The file format is inferred from `--out` when `--format` is omitted;
without `--out`, output goes to stdout.

By default the graph includes every node and every current edge. Use
`--active-only` to keep only nodes whose status is `active`, and
`--include-retired` to include retired edges with their retirement time.

The exports use stable node/edge ordering, fixed key order, and no export
timestamp, current date, or random layout. The same database state produces
byte-identical files. JSON and GraphML include node bodies; DOT uses compact
labels; HTML embeds the graph data, CSS, and JavaScript in one file with no
network requests. Open the HTML file directly in a browser; no server is
required.

Inside OpenCode, `/goldfish-graph` uses the `memory_export_graph` tool. Pass a
format, and optionally a path and flags:

```text
/goldfish-graph
/goldfish-graph html
/goldfish-graph json .opencode/memory/graph.json
/goldfish-graph html --active-only
/goldfish-graph graphml --include-retired
```

## Verifier evaluation

The plugin exposes `memory_eval` and `/goldfish-eval` for the semantic verifier
and conflict detector. They use temporary stores and never modify project
memory.

```text
/goldfish-eval support
/goldfish-eval conflicts
/goldfish-eval all
```

Bundled fixtures live in `evals/support.jsonl` and `evals/conflicts.jsonl`.
Each case seeds claims and files, builds the real evidence packet, and compares
the binary decision plus evidence grounding.

The report includes:

- verdict accuracy and false-support/false-conflict counts
- supported precision and recall
- conflict pair precision, recall, and F1
- candidate retrieval recall
- evidence grounding and expected-evidence matches
- per-case evidence quotes and failure reasons

Model runs are report-only and should not be used to tune a numeric threshold.
The useful signal is the decision plus grounded evidence.

## Repairing claims

`memory_repair` is a read-only repair packet. It shows citation freshness,
conflicts, neighbors, version history, deterministic findings, a recommended
tier, and suggested actions.

```text
memory_repair { "id": "gotcha/example" }
```

The agent presents the options and waits for approval. Apply one action through
the existing tools:

- metadata: `memory_admin.update`
- citations: `memory_admin.cite`
- content revision: `memory_remember` with `reason` and repair metadata
- replacement: `memory_remember` with `supersedes`
- ratification: `memory_admin.confirm`
- rejection: `memory_admin.reject`
- unsafe content: `memory_admin.archive`

Repair tiers are metadata, agent content, human authority, and incident. A
repair creates a new version; it never deletes history. Re-run `memory_verify`
after a content repair. Conflicts remain proposals until a human confirms or
dismisses them.

## Claim format

```json
{
  "kind": "decision",
  "title": "Billing uses an outbox table",
  "body": "Billing publishes events through an outbox table so provider webhook retries do not lose events on a crash.",
  "scope": ["services/billing/**", "packages/events/**"],
  "tags": ["billing", "reliability"],
  "basis": "cited",
  "confidence": 0.9,
  "citations": [
    {
      "type": "file",
      "locator": "docs/adr/012-outbox.md",
      "excerpt": "Publish through the outbox table; the relay retries failed deliveries."
    }
  ],
  "links": [
    { "to": "component/billing-worker", "type": "applies_to" }
  ]
}
```

Rules:

- `verified` requires human, test, or commit evidence.
- `cited` requires at least one citation. Missing file citations downgrade the
  claim to `inferred`.
- `derived` requires cited or verified premises linked with `derived_from`, and
  cannot auto-inject until the verifier confirms the premises and graph.
- `inferred` is accepted and queryable but cannot auto-inject until confirmed.
- Secrets and instruction-like text are rejected.
- Bodies are capped at 6,000 characters; store claims and sources, not code
  dumps.
- A material revision resets verification. Citation-only additions merge into
  the current version.

## Injection policy

The default policy allows `verified`, `cited`, and confirmed `derived` claims to
auto-inject. Strict scopes require stronger evidence:

```json
{
  "defaultAllowed": ["verified", "cited", "derived"],
  "strict": [
    { "pattern": "auth/**", "allowed": ["verified"] },
    { "pattern": "payments/**", "allowed": ["verified"] },
    { "pattern": "infra/prod/**", "allowed": ["verified"] },
    { "pattern": "**/migrations/**", "allowed": [] }
  ]
}
```

`allowed: []` means explicit recall only. If scope inference is uncertain, the
stricter matching policy wins.

## Plugin options

The local plugin loads with defaults. To customize, reference the plugin
directory from `opencode.json(c)` with an object entry:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./.opencode/plugins/project-memory",
      "options": {
        "autoRecall": true,
        "autoInject": true,
        "injectBudgetTokens": 700,
        "injectMaxCards": 5,
        "requireWritePermission": false,
        "policy": {
          "defaultAllowed": ["verified", "cited", "derived"],
          "strict": [
            { "pattern": "auth/**", "allowed": ["verified"] },
            { "pattern": "payments/**", "allowed": ["verified"] }
          ]
        },
        "verification": {
          "semantic": true,
          "model": "provider/model",
          "maxPerRun": 5,
          "readSources": true,
          "windowLines": 40,
          "maxSourceBytes": 4000,
          "maxPacketSourceBytes": 12000
        },
        "audit": {
          "maxPerRun": 10,
          "uniformRate": 0.03,
          "riskRate": 0.07
        },
        "conflict": {
          "maxPerRun": 3,
          "candidatesPerClaim": 3
        }
      }
    }
  ]
}
```

`verification.model` (or the top-level `verificationModel`) is a
`provider/model` reference. Leave it unset to use the session model. Set
`verification.semantic: false` for deterministic checks only. The audit rates
default to the 3% uniform / 7% risk-weighted sample. A claim audited within the
last 30 days at the same version is skipped until it changes or the cooldown
expires.

`verification.readSources` defaults to `true` for explicit verification. Source
windows are capped by `windowLines`, `maxSourceBytes`, and
`maxPacketSourceBytes`. Set it to `false` if source text must not be sent to a
remote model. `conflict.maxPerRun` and `conflict.candidatesPerClaim` bound
conflict-discovery cost and noise.

`requireWritePermission: true` routes `memory_remember` through
`ctx.permission.assert` with action `memory.remember`. The default is `false`
because the write policy is optimistic: writes are stored and auditable, while
injection is earned.

The plugin runs in OpenCode's Bun server and uses `bun:sqlite`. The CLI and
tests run on Node and use the built-in `node:sqlite`. The storage adapter tries
`bun:sqlite` first and falls back to `node:sqlite`; `better-sqlite3` is not used
because Bun does not support it.

## Data model

```text
nodes(id, kind, title, body, scope, tags, status, basis, confidence,
      verification_state, canonical_key, current_version, author,
      timestamps, auto_inject_eligible, metadata)

node_versions(node_id, version, title, body, basis, confidence, status,
              verification_state, author, reason, evidence, created_at)

edges(from_id, to_id, type, weight, metadata, created_at, retired_at)

sources(id, type, locator, content_hash, observed_at, metadata)

citations(node_id, node_version, source_id, locator, excerpt,
          excerpt_hash, observed_at)

injections(session_id, message_id, node_id, rank, tokens, source, created_at)

audits(node_id, node_version, trigger, sampled_by, risk_score, auditor,
       outcome, findings, created_at)

feedback(node_id, node_version, source, outcome, details, created_at)

conflict_proposals(id, node_a, node_b, node_a_version, node_b_version, status,
                   relation, reason, evidence, input_hash, timestamps)

events(ts, actor, action, node_id, payload)
```

`conflict_proposals.confidence` remains in older databases for compatibility but
is no longer written or displayed; proposals are judged by their evidence, not a
model grade.

Node kinds: `fact`, `decision`, `concept`, `component`, `pattern`, `gotcha`,
`runbook`, `document`, `source`, `session`.

Edge types: `cites`, `derived_from`, `supersedes`, `contradicts`, `revises`,
`depends_on`, `part_of`, `applies_to`, `related_to`, `documents`, `implements`.

Retrieval is FTS5 plus one-hop graph expansion. Graph neighbors are ranked below
their seed and are only added when they share a query term, the query asks for a
relationship, or the edge is a conflict/supersession edge.

## Repository layout

```text
src/core/        storage, schema, policy, recall, verification, conflicts,
                 source snapshots, formatting, export, deterministic graph
                 exports (JSON, GraphML, DOT, offline HTML)
src/cli/         CLI entry point
src/plugin/      OpenCode plugin, tools, hooks, runtime
.opencode/       local plugin wrapper and project-memory skill
evals/           support and conflict evaluation fixtures
docs/            citation source for the seed
test/            core tests and seed fixture
```

The core has no OpenCode imports. The plugin is an adapter over the same
`MemoryStore` the CLI and tests use.

## Current limits

- No embeddings or vector search yet. FTS5, aliases, tags, scope, and graph
  expansion come first; add vectors only if evaluation shows lexical misses.
- Repair is agent-orchestrated and versioned; the main agent inspects the repair
  packet and applies one approved action. Background workers are not implemented.
- Model evaluation is report-only. It measures binary decisions and evidence
  grounding, not confidence calibration.
- Conflict discovery compares a bounded candidate set; it is not an exhaustive
  all-pairs scan.
- Source snapshots cover file citations only. URLs, issues, PRs, and commits
  still rely on their recorded excerpt unless another adapter is added.
- `memory_scan` is a read-only structural scan. Automatic structural node
  ingestion, PR metadata, and session metadata adapters are not implemented.
  Session learning is explicit and read-only until candidates are approved.
- Session-learning candidates are staged in a local review file; the raw
  transcript is never stored or remembered.
- Import merges the current node state and preserves citations and edges, but it
  does not replay historical versions or carry audit/conflict-proposal review
  state.
- Stable project IDs survive local moves and renames of a Git worktree. A clone
  gets a new identity by design, and the database does not travel with the
  repository to another machine or data directory.
- Local-first only. There is no team sync or shared service.

## Development

```sh
npm run typecheck
npm test
npm run seed
```

The test suite covers policy and glob matching, recall filters and budgets,
material revisions and supersession, multi-conflict forks, bounded source
snapshots and redaction, citation freshness, derived cycles and premise
soundness, verifier verdicts and caching, conflict candidate retrieval,
proposal lifecycle, conflict confirmation, audit sampling and outcomes,
export/import round-trips, stable project identity and legacy adoption,
deterministic graph exports across JSON, GraphML, DOT, and offline HTML,
observe/edit operations, plugin tool registration, auto-recall and fallback
hooks, skill and command registration, onboarding status, and CLI end-to-end and
error paths.

## Safety

- Memory is data, not instructions. Recalled content is wrapped and labeled.
- Secrets and instruction-like text are rejected on write.
- Verifier source windows are redacted and explicitly labeled as untrusted data.
  They may leave the machine if the verifier model is remote; source reading is
  configurable and can be disabled.
- File citations carry content hashes; `revalidate` and `memory_verify` mark
  changed citations stale and remove them from auto-injection.
- Strict scopes require verified evidence.
- Confirmed conflicts mark both sides disputed and are never auto-resolved.
  Discovered conflicts are proposals until a human confirms them.
- Semantic verification is rejection-leaning, evidence-based, and cannot promote
  to `verified`.
- `memory_admin.confirm as="verified"` is explicit, permission-gated, and records
  a human citation.
- The plugin never bypasses normal edit, shell, or test permissions.
