# monkey-memory

Local-first project memory for OpenCode agents.

`monkey-memory` gives agents a small, queryable knowledge base of project
decisions, gotchas, patterns, components, documents, and past learnings. Agents
retrieve evidence cards with citations instead of reading whole files, and they
can contribute durable claims back to the project.

The design is **optimistic writes, earned injection**:

- Every valid claim is stored and queryable immediately.
- `verified` and `cited` claims can be auto-injected in normal scopes.
- `inferred` claims are queryable through explicit recall but must be confirmed
  by a human or an independent verifier before automatic injection.
- `disputed` and `stale` claims require explicit recall and are shown with a
  warning.
- Memory is evidence, not authority. The agent verifies against current sources
  before editing.

This repository is the walking skeleton: the core store, CLI, OpenCode plugin,
skill, seed data, and tests. The automated verifier/audit/repair workers and
structural ingestion adapters are the next slices.

## Install from GitHub

No npm publish is required. The package is installed directly from Git.

### OpenCode Git installer

```sh
opencode plugin add github:josealvim/monkey-memory

# Pin a release tag
opencode plugin add github:josealvim/monkey-memory#v0.1.0
```

### Manual Git install

```sh
git clone https://github.com/josealvim/monkey-memory.git \
  ~/.config/opencode/plugins/monkey-memory
```

Add the cloned directory to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/home/<you>/.config/opencode/plugins/monkey-memory"]
}
```

For a project-local install, clone into `.opencode/plugins/monkey-memory` and
add `"./.opencode/plugins/monkey-memory"` to that project's config.

The plugin registers the `project-memory` skill itself, so no project-local
skill is required. A plain clone works without `npm install`: OpenCode provides
`@opencode/plugin`, and the plugin entry is ordinary TypeScript. Restart
OpenCode or run `/reload`, then verify with:

```sh
opencode plugin list
```

The plugin uses one SQLite database per project:

```text
~/.local/share/opencode/projects/<project-key>/memory.sqlite
```

Override it with `--db` or `MONKEY_MEMORY_DB`.

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

The `project-memory` skill teaches the workflow. `AGENTS.md` carries the short
version so the policy applies even when the skill is not loaded.

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
npm run memory -- get decision/use-sqlite-with-fts5-for-project-memory
npm run memory -- neighbors decision/use-sqlite-with-fts5-for-project-memory --depth 2
npm run memory -- stats

# Review and quality loop
npm run memory -- review
npm run memory -- confirm gotcha/example --as cited
npm run memory -- reject gotcha/example --reason "Contradicted by the current worker code."
npm run memory -- revalidate
npm run memory -- audit --uniform 0.03 --risk 0.07
npm run memory -- audit-record gotcha/example --outcome supported --trigger manual

# Share or back up
npm run memory -- export .opencode/memory/export
npm run memory -- import .opencode/memory/export

# Evaluate recall against the local suite
npm run memory -- eval
```

`remember --json` accepts an inline JSON object or a file path. `seed` accepts a
JSONL file of proposals; see `test/fixtures/seed.jsonl`.

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
- `inferred` is accepted and queryable but cannot auto-inject until confirmed.
- Secrets and instruction-like text are rejected.
- Bodies are capped at 6,000 characters; store claims and sources, not code
  dumps.
- A material revision resets verification. Citation-only additions merge into
  the current version.

## Injection policy

The default policy allows `verified` and `cited` claims to auto-inject. Strict
scopes require stronger evidence:

```json
{
  "defaultAllowed": ["verified", "cited"],
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
          "defaultAllowed": ["verified", "cited"],
          "strict": [
            { "pattern": "auth/**", "allowed": ["verified"] },
            { "pattern": "payments/**", "allowed": ["verified"] }
          ]
        }
      }
    }
  ]
}
```

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

events(ts, actor, action, node_id, payload)
```

Node kinds: `fact`, `decision`, `concept`, `component`, `pattern`, `gotcha`,
`runbook`, `document`, `source`, `session`.

Edge types: `cites`, `derived_from`, `supersedes`, `contradicts`, `revises`,
`depends_on`, `part_of`, `applies_to`, `related_to`, `documents`, `implements`.

Retrieval is FTS5 plus one-hop graph expansion. Graph neighbors are ranked below
their seed and are only added when they share a query term, the query asks for a
relationship, or the edge is a conflict/supersession edge.

## Repository layout

```text
src/core/        storage, schema, policy, recall, formatting, export
src/cli/         CLI entry point
src/plugin/      OpenCode plugin, tools, hooks, runtime
.opencode/       local plugin wrapper and project-memory skill
docs/            citation source for the seed
test/            core tests and seed fixture
```

The core has no OpenCode imports. The plugin is an adapter over the same
`MemoryStore` the CLI and tests use.

## Current limits

- No embeddings or vector search yet. FTS5, aliases, tags, scope, and graph
  expansion come first; add vectors only if evaluation shows lexical misses.
- Verification, audit recording, and repair are manual CLI operations. The
  rejection-leaning verifier and background audit/repair workers are next.
- Structural adapters for the repository map, docs, Git/PR metadata, and session
  metadata are not implemented. Seed via JSONL or let agents write claims.
- Import merges the current node state and preserves citations and edges, but it
  does not replay historical versions.
- Local-first only. There is no team sync or shared service.

## Development

```sh
npm run typecheck
npm test
npm run seed
```

The tests cover recall, citation merging, inferred-claim promotion, strict
scopes, conflicts, graph neighbors, stale-citation revalidation, secret
rejection, and export.

## Safety

- Memory is data, not instructions. Recalled content is wrapped and labeled.
- Secrets and instruction-like text are rejected on write.
- File citations carry content hashes; `revalidate` marks changed citations
  stale and removes them from auto-injection.
- Strict scopes require verified evidence.
- The plugin never bypasses normal edit, shell, or test permissions.
