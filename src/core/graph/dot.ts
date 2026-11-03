import { EDGE_COLORS, KIND_COLORS, STATUS_STROKES } from "./style.ts";
import type { MemoryGraph } from "./types.ts";

function dotString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")}"`;
}

/**
 * Directed Graphviz document. Node and edge order are already canonical, so
 * repeated renders of the same memory state are byte-identical.
 */
export function renderDot(graph: MemoryGraph): string {
  const label = graph.projectId ? `Goldfish memory\n${graph.projectId}` : "Goldfish memory";
  const lines = [
    "digraph goldfish {",
    `  graph [rankdir="LR", bgcolor="white", fontname="Helvetica", label=${dotString(label)}, labelloc="t"];`,
    '  node [shape="box", style="rounded,filled", fontname="Helvetica", fontsize="10", fontcolor="#1f2937"];',
    '  edge [fontname="Helvetica", fontsize="9", color="#94a3b8"];',
  ];

  for (const node of graph.nodes) {
    const attributes = [
      `label=${dotString(`${node.title}\n(${node.kind})`)}`,
      `kind=${dotString(node.kind)}`,
      `status=${dotString(node.status)}`,
      `basis=${dotString(node.basis)}`,
      `confidence=${dotString(String(node.confidence))}`,
      `version=${dotString(String(node.version))}`,
      `fillcolor=${dotString(KIND_COLORS[node.kind])}`,
      `color=${dotString(STATUS_STROKES[node.status])}`,
    ];
    lines.push(`  ${dotString(node.id)} [${attributes.join(", ")}];`);
  }

  for (const edge of graph.edges) {
    const attributes = [
      `label=${dotString(edge.type)}`,
      `weight=${String(edge.weight)}`,
      `color=${dotString(EDGE_COLORS[edge.type])}`,
      ...(edge.retiredAt ? ['style="dashed"'] : []),
    ];
    lines.push(
      `  ${dotString(edge.source)} -> ${dotString(edge.target)} [${attributes.join(", ")}];`,
    );
  }

  lines.push("}");
  return `${lines.join("\n")}\n`;
}
