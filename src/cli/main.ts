#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MemoryStore } from "../core/store.ts";
import { defaultDbPath, ensureParent, findProjectRoot } from "../core/paths.ts";
import {
  formatNeighbors,
  formatNode,
  formatRecall,
  formatRemember,
  formatReview,
  formatStats,
} from "../core/format.ts";
import type {
  AuditRecordInput,
  CitationInput,
  EdgeType,
  LinkInput,
  MemoryNode,
  MemoryProposal,
  NodeKind,
  RecallQuery,
  SourceType,
} from "../core/types.ts";

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Map<string, string[]>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] ?? "help";
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const body = argument.slice(2);
    const equals = body.indexOf("=");
    if (equals >= 0) {
      pushFlag(flags, body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      pushFlag(flags, body, next);
      index++;
    } else {
      pushFlag(flags, body, "true");
    }
  }
  return { command, positionals, flags };
}

function pushFlag(flags: Map<string, string[]>, name: string, value: string): void {
  const existing = flags.get(name) ?? [];
  existing.push(value);
  flags.set(name, existing);
}

function flag(args: ParsedArgs, name: string): string | undefined {
  return args.flags.get(name)?.at(-1);
}

function flagAll(args: ParsedArgs, name: string): string[] {
  return args.flags.get(name) ?? [];
}

function boolFlag(args: ParsedArgs, name: string, fallback = false): boolean {
  const value = flag(args, name);
  if (value === undefined) return fallback;
  return value !== "false" && value !== "0" && value !== "no";
}

function numberFlag(args: ParsedArgs, name: string): number | undefined {
  const value = flag(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function withStore<T>(args: ParsedArgs, callback: (store: MemoryStore, projectRoot: string) => T | Promise<T>): Promise<T> {
  const projectRoot = path.resolve(flag(args, "project") ?? findProjectRoot(process.cwd()));
  const dbPath = flag(args, "db") ?? defaultDbPath(projectRoot);
  ensureParent(dbPath);
  const store = await MemoryStore.open({ dbPath, projectRoot });
  try {
    return await callback(store, projectRoot);
  } finally {
    store.close();
  }
}

function readJsonOrFile(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);
  if (trimmed === "-") return JSON.parse(readFileSync(0, "utf8"));
  return JSON.parse(readFileSync(path.resolve(trimmed), "utf8"));
}

function readJsonLines(file: string): unknown[] {
  const content = readFileSync(path.resolve(file), "utf8");
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSON on line ${index + 1} of ${file}: ${String(error)}`);
      }
    });
}

function readFileIfExists(file: string): unknown[] {
  return existsSync(file) ? readJsonLines(file) : [];
}

function parseObject(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Import targets before the nodes that link to them. A simple reverse
 * topological order is enough; cycles fall back to file order.
 */
function orderNodesByDependencies(
  nodes: MemoryNode[],
  edges: Array<{ from_id: string; to_id: string }>,
): MemoryNode[] {
  const byID = new Map(nodes.map((node) => [node.id, node]));
  const ids = new Set(byID.keys());
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!ids.has(edge.from_id) || !ids.has(edge.to_id)) continue;
    if (!outgoing.has(edge.from_id)) outgoing.set(edge.from_id, new Set());
    outgoing.get(edge.from_id)!.add(edge.to_id);
    if (!incoming.has(edge.to_id)) incoming.set(edge.to_id, new Set());
    incoming.get(edge.to_id)!.add(edge.from_id);
  }

  const remainingOut = new Map(nodes.map((node) => [node.id, outgoing.get(node.id)?.size ?? 0]));
  const queue = nodes.filter((node) => (remainingOut.get(node.id) ?? 0) === 0).map((node) => node.id);
  const ordered: string[] = [];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
    for (const parent of incoming.get(id) ?? []) {
      if (seen.has(parent)) continue;
      const remaining = (remainingOut.get(parent) ?? 1) - 1;
      remainingOut.set(parent, remaining);
      if (remaining === 0) queue.push(parent);
    }
  }
  for (const node of nodes) {
    if (!seen.has(node.id)) ordered.push(node.id);
  }
  return ordered.map((id) => byID.get(id)!).filter(Boolean);
}

function splitList(values: string[]): string[] {
  return values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
}

function parseProposal(value: unknown): MemoryProposal {
  if (!value || typeof value !== "object") throw new Error("Expected a JSON object for the memory proposal.");
  const proposal = value as Partial<MemoryProposal>;
  if (!proposal.kind || !proposal.title || !proposal.body) {
    throw new Error("A proposal requires kind, title, and body.");
  }
  return proposal as MemoryProposal;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;

    case "seed": {
      const file = args.positionals[0] ?? "test/fixtures/seed.jsonl";
      const proposals = readJsonLines(file).map(parseProposal);
      await withStore(args, (store) => {
        const results = store.seed(proposals);
        for (const result of results) console.log(formatRemember(result));
      });
      return;
    }

    case "recall": {
      const queryText = args.positionals.join(" ").trim();
      if (!queryText) throw new Error("Usage: memory recall <query>");
      const query: RecallQuery = {
        query: queryText,
        scope: flagAll(args, "scope"),
        kinds: splitList(flagAll(args, "kinds")) as NodeKind[],
        limit: numberFlag(args, "limit"),
        budgetTokens: numberFlag(args, "budget"),
        autoInjectOnly: boolFlag(args, "auto-inject"),
        includeInferred: !boolFlag(args, "no-inferred"),
        includeDisputed: boolFlag(args, "include-disputed"),
        includeStale: boolFlag(args, "include-stale"),
      };
      await withStore(args, (store) => {
        const result = store.recall(query);
        console.log(formatRecall(result));
        console.log(`\n(${result.cards.length} cards, ${result.tokens} approx tokens, ${result.candidates} candidates)`);
      });
      return;
    }

    case "remember": {
      const raw = flag(args, "json") ?? args.positionals[0];
      if (!raw) throw new Error("Usage: memory remember --json <file-or-json>");
      const proposal = parseProposal(readJsonOrFile(raw));
      await withStore(args, (store) => {
        const result = store.remember(proposal, {
          author: { type: "human", id: flag(args, "author") ?? "cli" },
        });
        console.log(formatRemember(result));
      });
      return;
    }

    case "get": {
      const id = args.positionals[0];
      if (!id) throw new Error("Usage: memory get <id>");
      await withStore(args, (store) => {
        const detail = store.get(id);
        if (!detail) {
          console.error(`No memory node found for ${id}`);
          process.exitCode = 1;
          return;
        }
        console.log(formatNode(detail));
      });
      return;
    }

    case "neighbors": {
      const id = args.positionals[0];
      if (!id) throw new Error("Usage: memory neighbors <id>");
      await withStore(args, (store) => {
        const result = store.neighbors(id, {
          edgeTypes: splitList(flagAll(args, "edge-types")) as EdgeType[],
          direction: (flag(args, "direction") as "out" | "in" | "both" | undefined) ?? "both",
          depth: numberFlag(args, "depth"),
          limit: numberFlag(args, "limit"),
        });
        if (!result) {
          console.error(`No memory node found for ${id}`);
          process.exitCode = 1;
          return;
        }
        console.log(formatNeighbors(result));
      });
      return;
    }

    case "review": {
      await withStore(args, (store) => {
        console.log(formatReview(store.review()));
      });
      return;
    }

    case "confirm": {
      const id = args.positionals[0];
      if (!id) throw new Error("Usage: memory confirm <id> [--as cited|verified]");
      const as = flag(args, "as") as "cited" | "verified" | undefined;
      await withStore(args, (store) => {
        const node = store.confirm(id, {
          as,
          author: { type: "human", id: flag(args, "author") ?? "cli" },
          reason: flag(args, "reason"),
        });
        if (!node) {
          console.error(`No memory node found for ${id}`);
          process.exitCode = 1;
          return;
        }
        const detail = store.get(node.id);
        if (detail) console.log(formatNode(detail));
      });
      return;
    }

    case "reject": {
      const id = args.positionals[0];
      if (!id) throw new Error("Usage: memory reject <id> --reason <reason>");
      await withStore(args, (store) => {
        const node = store.reject(id, {
          author: { type: "human", id: flag(args, "author") ?? "cli" },
          reason: flag(args, "reason") ?? "Rejected by human review.",
        });
        if (!node) {
          console.error(`No memory node found for ${id}`);
          process.exitCode = 1;
          return;
        }
        console.log(formatRemember({ action: "revised", node }));
      });
      return;
    }

    case "revalidate": {
      await withStore(args, (store) => {
        const result = store.revalidate();
        console.log(`Checked ${result.checked} node(s); marked ${result.markedStale} stale.`);
      });
      return;
    }

    case "audit": {
      await withStore(args, (store) => {
        const candidates = store.auditCandidates({
          uniformRate: numberFlag(args, "uniform"),
          riskRate: numberFlag(args, "risk"),
          max: numberFlag(args, "max"),
        });
        if (!candidates.length) {
          console.log("No auto-inject-eligible nodes are available for audit.");
          return;
        }
        for (const candidate of candidates) {
          console.log(
            `- ${candidate.node.id} [${candidate.trigger}] risk=${candidate.riskScore.toFixed(2)} ` +
              `(${candidate.reasons.join("; ") || "selected"})`,
          );
        }
      });
      return;
    }

    case "audit-record": {
      const id = args.positionals[0];
      const outcome = flag(args, "outcome") as AuditRecordInput["outcome"] | undefined;
      if (!id || !outcome) {
        throw new Error("Usage: memory audit-record <id> --outcome <outcome> [--trigger manual]");
      }
      const findingsRaw = flag(args, "findings");
      await withStore(args, (store) => {
        store.recordAudit({
          nodeID: id,
          version: numberFlag(args, "version") ?? 0,
          trigger: (flag(args, "trigger") as AuditRecordInput["trigger"] | undefined) ?? "manual",
          outcome,
          riskScore: numberFlag(args, "risk") ?? 0,
          findings: findingsRaw ? (readJsonOrFile(findingsRaw) as Record<string, unknown>) : undefined,
        });
        console.log(`Recorded audit for ${id}: ${outcome}`);
      });
      return;
    }

    case "export": {
      const outDir = path.resolve(flag(args, "out") ?? args.positionals[0] ?? ".opencode/memory/export");
      mkdirSync(outDir, { recursive: true });
      await withStore(args, (store) => {
        const bundle = store.exportBundle();
        writeFileSync(path.join(outDir, "nodes.jsonl"), bundle.nodes.map((node) => JSON.stringify(node)).join("\n") + "\n");
        writeJsonLines(path.join(outDir, "versions.jsonl"), bundle.versions);
        writeJsonLines(path.join(outDir, "edges.jsonl"), bundle.edges);
        writeJsonLines(path.join(outDir, "sources.jsonl"), bundle.sources);
        writeJsonLines(path.join(outDir, "citations.jsonl"), bundle.citations);
        writeFileSync(
          path.join(outDir, "manifest.json"),
          JSON.stringify(
            {
              schemaVersion: bundle.schemaVersion,
              exportedAt: bundle.exportedAt,
              projectRoot: bundle.projectRoot,
              counts: {
                nodes: bundle.nodes.length,
                versions: bundle.versions.length,
                edges: bundle.edges.length,
                sources: bundle.sources.length,
                citations: bundle.citations.length,
              },
            },
            null,
            2,
          ) + "\n",
        );
        console.log(`Exported memory bundle to ${outDir}`);
      });
      return;
    }

    case "eval": {
      const file = args.positionals[0] ?? "test/fixtures/eval.jsonl";
      const cases = readJsonLines(file).map((value, index) => {
        if (!value || typeof value !== "object") throw new Error(`Invalid eval case on line ${index + 1}.`);
        const item = value as { query?: string; expected?: string[]; k?: number; scope?: string[] };
        if (!item.query || !Array.isArray(item.expected)) {
          throw new Error(`Eval case on line ${index + 1} requires query and expected[].`);
        }
        return { query: item.query, expected: item.expected, k: item.k, scope: item.scope };
      });
      await withStore(args, (store) => {
        let totalRecall = 0;
        let totalPrecision = 0;
        let totalMRR = 0;
        for (const item of cases) {
          const k = item.k ?? numberFlag(args, "k") ?? 5;
          const result = store.recall({
            query: item.query,
            scope: item.scope,
            limit: k,
            includeInferred: true,
          });
          const found = item.expected.filter((id) => result.cards.some((card) => card.id === id));
          const recall = item.expected.length ? found.length / item.expected.length : 0;
          const precision = result.cards.length ? found.length / result.cards.length : 0;
          const firstRank = result.cards.findIndex((card) => item.expected.includes(card.id)) + 1;
          const mrr = firstRank > 0 ? 1 / firstRank : 0;
          totalRecall += recall;
          totalPrecision += precision;
          totalMRR += mrr;
          const status = recall > 0 ? "PASS" : "FAIL";
          console.log(
            `${status} recall=${recall.toFixed(2)} precision=${precision.toFixed(2)} mrr=${mrr.toFixed(2)}  ${item.query}`,
          );
        }
        const count = cases.length || 1;
        console.log(
          `\nAverage recall@k=${(totalRecall / count).toFixed(3)} precision=${(totalPrecision / count).toFixed(3)} mrr=${(totalMRR / count).toFixed(3)}`,
        );
      });
      return;
    }

    case "import": {
      const directory = path.resolve(args.positionals[0] ?? flag(args, "dir") ?? ".opencode/memory/export");
      const nodesFile = path.join(directory, "nodes.jsonl");
      const sourcesFile = path.join(directory, "sources.jsonl");
      const citationsFile = path.join(directory, "citations.jsonl");
      const edgesFile = path.join(directory, "edges.jsonl");
      const rawNodes = readJsonLines(nodesFile) as MemoryNode[];
      const rawSources = readFileIfExists(sourcesFile) as Array<{
        id: string;
        type: SourceType;
        locator: string;
        metadata_json?: string;
      }>;
      const rawCitations = readFileIfExists(citationsFile) as Array<{
        node_id: string;
        node_version: number;
        source_id: string;
        locator_json?: string;
        excerpt?: string;
      }>;
      const rawEdges = readFileIfExists(edgesFile) as Array<{
        from_id: string;
        to_id: string;
        type: EdgeType;
        weight?: number;
      }>;

      const sourcesByID = new Map(rawSources.map((source) => [source.id, source]));
      const citationsByNode = new Map<string, CitationInput[]>();
      for (const citation of rawCitations) {
        const source = sourcesByID.get(citation.source_id);
        if (!source) continue;
        const key = `${citation.node_id}:${Number(citation.node_version)}`;
        const list = citationsByNode.get(key) ?? [];
        list.push({
          type: source.type,
          locator: source.locator,
          excerpt: citation.excerpt,
          metadata: parseObject(citation.locator_json),
        });
        citationsByNode.set(key, list);
      }

      const edgesByFrom = new Map<
        string,
        { supersedes?: string; contradicts: string[]; links: LinkInput[] }
      >();
      for (const edge of rawEdges) {
        const entry = edgesByFrom.get(edge.from_id) ?? { contradicts: [], links: [] };
        if (edge.type === "supersedes") entry.supersedes = edge.to_id;
        else if (edge.type === "contradicts") entry.contradicts.push(edge.to_id);
        else entry.links.push({ to: edge.to_id, type: edge.type, weight: edge.weight ?? 1 });
        edgesByFrom.set(edge.from_id, entry);
      }

      const ordered = orderNodesByDependencies(rawNodes, rawEdges);

      await withStore(args, (store) => {
        const counts: Record<string, number> = {};
        for (const node of ordered) {
          const edges = edgesByFrom.get(node.id);
          const citations = citationsByNode.get(`${node.id}:${Number(node.version)}`) ?? [];
          const proposal: MemoryProposal = {
            kind: node.kind,
            title: node.title,
            body: node.body,
            scope: node.scope,
            tags: node.tags,
            basis: node.basis,
            confidence: node.confidence,
            citations,
            links: edges?.links,
            supersedes: edges?.supersedes,
            contradicts: edges?.contradicts.length ? edges.contradicts : undefined,
            metadata: { ...node.metadata, importedFrom: directory },
          };
          const result = store.remember(proposal, {
            author: node.author ?? { type: "system", id: "import" },
          });
          counts[result.action] = (counts[result.action] ?? 0) + 1;
        }
        const summary = Object.entries(counts)
          .map(([action, count]) => `${action}=${count}`)
          .join(", ");
        console.log(`Imported ${rawNodes.length} node(s) from ${directory}${summary ? ` (${summary})` : ""}`);
      });
      return;
    }

    case "stats": {
      await withStore(args, (store) => {
        console.log(formatStats(store.stats()));
      });
      return;
    }

    default:
      console.error(`Unknown command: ${args.command}`);
      printHelp();
      process.exitCode = 1;
  }
}

function writeJsonLines(file: string, values: unknown[]): void {
  writeFileSync(file, values.map((value) => JSON.stringify(value)).join("\n") + (values.length ? "\n" : ""));
}

function printHelp(): void {
  console.log(`monkey-memory — local-first project memory for OpenCode

Usage:
  memory <command> [options]

Commands:
  seed [file]                     Load memory proposals from JSONL
  recall <query>                  Search project memory
  remember --json <file-or-json>  Propose a memory node
  get <id>                        Show a node, its sources, and relationships
  neighbors <id>                  Walk the knowledge graph
  review                          Show unverified, disputed, and stale nodes
  confirm <id> [--as cited|verified]
  reject <id> --reason <text>
  revalidate                      Mark nodes with changed file citations stale
  audit                           List sampled audit candidates
  audit-record <id> --outcome <outcome> [--trigger manual]
  eval [file]                     Evaluate recall@k against a JSONL suite
  export [directory]              Write a JSONL export bundle
  import [directory]              Merge an exported JSONL bundle
  stats                           Show store counts

Common options:
  --project <dir>                 Project root (default: nearest marker)
  --db <path>                     SQLite path (default: OpenCode data directory)
  --scope <glob>                  Scope filter (repeatable)
  --limit <n>                     Result limit
  --budget <tokens>               Approximate token budget
  --no-inferred                   Exclude inferred claims from explicit recall
  --include-disputed              Include disputed claims in explicit recall
  --include-stale                 Include stale claims in explicit recall
  --auto-inject                   Apply the auto-injection policy
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
