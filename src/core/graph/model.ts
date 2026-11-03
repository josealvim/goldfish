import type {
  BuildGraphOptions,
  MemoryGraph,
  MemoryGraphEdge,
  MemoryGraphNode,
  MemoryGraphSnapshot,
} from "./types.ts";

/**
 * Locale-independent comparison. `localeCompare` can vary with the host
 * locale, so graph exports use UTF-16 code-unit order instead.
 */
export function compareGraphText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNodes(left: MemoryGraphNode, right: MemoryGraphNode): number {
  return compareGraphText(left.id, right.id);
}

function compareEdges(left: MemoryGraphEdge, right: MemoryGraphEdge): number {
  return (
    compareGraphText(left.source, right.source) ||
    compareGraphText(left.target, right.target) ||
    compareGraphText(left.type, right.type) ||
    compareGraphText(left.createdAt, right.createdAt)
  );
}

function projectNode(node: MemoryGraphSnapshot["nodes"][number]): MemoryGraphNode {
  return {
    id: node.id,
    kind: node.kind,
    title: node.title,
    body: node.body,
    status: node.status,
    basis: node.basis,
    confidence: node.confidence,
    verificationState: node.verificationState,
    version: node.version,
    scope: [...node.scope].sort(compareGraphText),
    tags: [...node.tags].sort(compareGraphText),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    autoInjectEligible: node.autoInjectEligible,
  };
}

/**
 * Build a deterministic, presentation-ready graph.
 *
 * Defaults keep all node statuses and current edges. `activeOnly` retains only
 * nodes whose status is active. Retired edges are dropped unless requested.
 */
export function buildMemoryGraph(
  snapshot: MemoryGraphSnapshot,
  options: BuildGraphOptions = {},
): MemoryGraph {
  const activeOnly = options.activeOnly === true;
  const includeRetired = options.includeRetired === true;

  const nodes = snapshot.nodes
    .filter((node) => !activeOnly || node.status === "active")
    .map(projectNode)
    .sort(compareNodes);
  const nodeIDs = new Set(nodes.map((node) => node.id));

  const edges = snapshot.edges
    .filter((edge) => includeRetired || !edge.retiredAt)
    .filter((edge) => nodeIDs.has(edge.fromID) && nodeIDs.has(edge.toID))
    .map((edge): MemoryGraphEdge => ({
      source: edge.fromID,
      target: edge.toID,
      type: edge.type,
      weight: edge.weight,
      createdAt: edge.createdAt,
      ...(edge.retiredAt ? { retiredAt: edge.retiredAt } : {}),
    }))
    .sort(compareEdges);

  return {
    schemaVersion: 1,
    ...(snapshot.projectId ? { projectId: snapshot.projectId } : {}),
    nodes,
    edges,
  };
}
