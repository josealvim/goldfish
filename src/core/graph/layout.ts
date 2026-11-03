import type { GraphLayout, MemoryGraph, MemoryGraphNode } from "./types.ts";

export const GRAPH_VIEW_WIDTH = 1200;
export const GRAPH_VIEW_HEIGHT = 800;
export const GRAPH_VIEW_PADDING = 70;

const FORCE_NODE_LIMIT = 400;

type MutablePosition = { x: number; y: number };

function sortText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function forceLayout(nodes: MemoryGraphNode[], edges: MemoryGraph["edges"]): Map<string, MutablePosition> {
  const count = nodes.length;
  const area = GRAPH_VIEW_WIDTH * GRAPH_VIEW_HEIGHT;
  const ideal = Math.sqrt(area / count);
  const positions = new Map<string, MutablePosition>();
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));

  // Deterministic phyllotaxis start: no Math.random, and the order is stable
  // because graph nodes are already sorted by ID.
  for (let index = 0; index < count; index++) {
    const radius = Math.sqrt(index + 0.5) * ideal * 0.5;
    const angle = index * goldenAngle;
    positions.set(nodes[index]!.id, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    });
  }

  const iterations = Math.min(300, Math.max(120, Math.round(70 + count * 1.4)));
  let temperature = ideal * 0.15;

  for (let iteration = 0; iteration < iterations; iteration++) {
    const displacement = new Map<string, MutablePosition>();
    for (const node of nodes) displacement.set(node.id, { x: 0, y: 0 });

    for (let left = 0; left < count; left++) {
      for (let right = left + 1; right < count; right++) {
        const leftID = nodes[left]!.id;
        const rightID = nodes[right]!.id;
        const a = positions.get(leftID)!;
        const b = positions.get(rightID)!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distanceSquared = dx * dx + dy * dy;
        if (distanceSquared < 0.0001) {
          // Coincident nodes are common at the exact center. This deterministic
          // nudge separates them without introducing randomness.
          dx = ((left + 1) % 7) - 3;
          dy = ((right + 1) % 11) - 5;
          distanceSquared = Math.max(0.0001, dx * dx + dy * dy);
        }
        const distance = Math.sqrt(distanceSquared);
        const force = (ideal * ideal) / distance;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        const aDisp = displacement.get(leftID)!;
        const bDisp = displacement.get(rightID)!;
        aDisp.x += fx;
        aDisp.y += fy;
        bDisp.x -= fx;
        bDisp.y -= fy;
      }
    }

    for (const edge of edges) {
      const a = positions.get(edge.source);
      const b = positions.get(edge.target);
      if (!a || !b) continue;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const distance = Math.max(0.01, Math.sqrt(dx * dx + dy * dy));
      const strength = Math.max(0.25, Math.min(4, edge.weight));
      const force = ((distance * distance) / ideal) * 0.03 * strength;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      const aDisp = displacement.get(edge.source)!;
      const bDisp = displacement.get(edge.target)!;
      aDisp.x -= fx;
      aDisp.y -= fy;
      bDisp.x += fx;
      bDisp.y += fy;
    }

    for (const node of nodes) {
      const position = positions.get(node.id)!;
      const disp = displacement.get(node.id)!;
      // Gentle center gravity keeps disconnected components together.
      disp.x -= position.x * 0.006;
      disp.y -= position.y * 0.006;
      const magnitude = Math.sqrt(disp.x * disp.x + disp.y * disp.y);
      if (magnitude > 0) {
        const limited = Math.min(magnitude, temperature);
        position.x += (disp.x / magnitude) * limited;
        position.y += (disp.y / magnitude) * limited;
      }
    }
    temperature *= 0.985;
  }

  return positions;
}

function radialLayout(nodes: MemoryGraphNode[]): Map<string, MutablePosition> {
  const positions = new Map<string, MutablePosition>();
  const kinds = [...new Set(nodes.map((node) => node.kind))].sort(sortText);
  const clusterRadius = Math.max(240, kinds.length * 80);

  kinds.forEach((kind, kindIndex) => {
    const group = nodes.filter((node) => node.kind === kind);
    const clusterAngle = kinds.length === 1 ? 0 : (2 * Math.PI * kindIndex) / kinds.length;
    const centerX = kinds.length === 1 ? 0 : Math.cos(clusterAngle) * clusterRadius;
    const centerY = kinds.length === 1 ? 0 : Math.sin(clusterAngle) * clusterRadius;
    const ringRadius = group.length === 1 ? 0 : Math.max(55, group.length * 13);
    group.forEach((node, index) => {
      const angle = group.length === 1 ? 0 : (2 * Math.PI * index) / group.length;
      positions.set(node.id, {
        x: centerX + Math.cos(angle) * ringRadius,
        y: centerY + Math.sin(angle) * ringRadius,
      });
    });
  });

  return positions;
}

function normalize(positions: Map<string, MutablePosition>): GraphLayout {
  const values = [...positions.values()];
  if (!values.length) return {};

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const position of values) {
    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
    maxX = Math.max(maxX, position.x);
    maxY = Math.max(maxY, position.y);
  }

  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const availableWidth = GRAPH_VIEW_WIDTH - GRAPH_VIEW_PADDING * 2;
  const availableHeight = GRAPH_VIEW_HEIGHT - GRAPH_VIEW_PADDING * 2;
  const scale =
    spanX < 0.0001 && spanY < 0.0001
      ? 1
      : Math.min(
          spanX < 0.0001 ? Infinity : availableWidth / spanX,
          spanY < 0.0001 ? Infinity : availableHeight / spanY,
        );

  const offsetX = (GRAPH_VIEW_WIDTH - spanX * scale) / 2 - minX * scale;
  const offsetY = (GRAPH_VIEW_HEIGHT - spanY * scale) / 2 - minY * scale;
  const result: GraphLayout = {};
  for (const [id, position] of positions) {
    const x = Math.round((position.x * scale + offsetX) * 100) / 100;
    const y = Math.round((position.y * scale + offsetY) * 100) / 100;
    result[id] = { x: x === 0 ? 0 : x, y: y === 0 ? 0 : y };
  }
  return result;
}

/**
 * Deterministic layout for the offline HTML explorer.
 *
 * The force layout runs with a fixed iteration count and a deterministic
 * initial arrangement. Above the node limit, a clustered radial layout keeps
 * export time bounded. No random source is used.
 */
export function layoutGraph(graph: MemoryGraph): GraphLayout {
  if (!graph.nodes.length) return {};
  if (graph.nodes.length === 1) {
    return {
      [graph.nodes[0]!.id]: { x: GRAPH_VIEW_WIDTH / 2, y: GRAPH_VIEW_HEIGHT / 2 },
    };
  }
  const positions =
    graph.nodes.length > FORCE_NODE_LIMIT
      ? radialLayout(graph.nodes)
      : forceLayout(graph.nodes, graph.edges);
  return normalize(positions);
}
