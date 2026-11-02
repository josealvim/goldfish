import type {
  CitationInput,
  EdgeType,
  LinkInput,
  MemoryNode,
  MemoryProposal,
  SourceType,
} from "./types.ts";
import type { MemoryStore } from "./store.ts";

export interface ImportSourceRow {
  id: string;
  type: SourceType;
  locator: string;
  metadata_json?: string;
}

export interface ImportCitationRow {
  node_id: string;
  node_version: number;
  source_id: string;
  locator_json?: string;
  excerpt?: string;
}

export interface ImportEdgeRow {
  from_id: string;
  to_id: string;
  type: EdgeType;
  weight?: number;
}

export interface ImportBundle {
  nodes: MemoryNode[];
  sources: ImportSourceRow[];
  citations: ImportCitationRow[];
  edges: ImportEdgeRow[];
}

export interface ImportResult {
  imported: number;
  counts: Record<string, number>;
}

/**
 * Merge an exported bundle into a store.
 *
 * Targets are imported before the nodes that link to them, so graph edges
 * survive when the bundle is not already topologically ordered. Historical
 * versions are not replayed; the current node state is merged.
 */
export function importBundle(
  store: MemoryStore,
  bundle: ImportBundle,
  options: { directory?: string } = {},
): ImportResult {
  const sourcesByID = new Map(bundle.sources.map((source) => [source.id, source]));
  const citationsByNode = new Map<string, CitationInput[]>();
  for (const citation of bundle.citations) {
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
  for (const edge of bundle.edges) {
    const entry = edgesByFrom.get(edge.from_id) ?? { contradicts: [], links: [] };
    if (edge.type === "supersedes") entry.supersedes = edge.to_id;
    else if (edge.type === "contradicts") entry.contradicts.push(edge.to_id);
    else entry.links.push({ to: edge.to_id, type: edge.type, weight: edge.weight ?? 1 });
    edgesByFrom.set(edge.from_id, entry);
  }

  const ordered = orderNodesByDependencies(bundle.nodes, bundle.edges);
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
      metadata: {
        ...node.metadata,
        ...(options.directory ? { importedFrom: options.directory } : {}),
      },
    };
    const result = store.remember(proposal, {
      author: node.author ?? { type: "system", id: "import" },
    });
    counts[result.action] = (counts[result.action] ?? 0) + 1;
  }

  return { imported: bundle.nodes.length, counts };
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
export function orderNodesByDependencies(
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
