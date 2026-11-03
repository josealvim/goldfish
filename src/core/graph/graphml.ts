import type { MemoryGraph } from "./types.ts";

const GRAPH_KEYS = [
  ["g_schemaVersion", "schemaVersion", "int"],
  ["g_projectId", "projectId", "string"],
] as const;

const NODE_KEYS = [
  ["n_kind", "kind", "string"],
  ["n_title", "title", "string"],
  ["n_body", "body", "string"],
  ["n_status", "status", "string"],
  ["n_basis", "basis", "string"],
  ["n_confidence", "confidence", "double"],
  ["n_verification", "verification", "string"],
  ["n_version", "version", "int"],
  ["n_scope", "scope", "string"],
  ["n_tags", "tags", "string"],
  ["n_created", "created", "string"],
  ["n_updated", "updated", "string"],
  ["n_autoInject", "autoInject", "boolean"],
] as const;

const EDGE_KEYS = [
  ["e_type", "type", "string"],
  ["e_weight", "weight", "double"],
  ["e_created", "created", "string"],
  ["e_retired", "retired", "string"],
] as const;

const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

function xmlText(value: string): string {
  return value
    .replace(INVALID_XML_CHARS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function xmlAttr(value: string): string {
  return xmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function key(
  id: string,
  target: "graph" | "node" | "edge",
  name: string,
  type: string,
): string {
  return `  <key id="${id}" for="${target}" attr.name="${name}" attr.type="${type}"/>`;
}

function data(id: string, value: string, indent = "    "): string {
  return `${indent}<data key="${id}">${xmlText(value)}</data>`;
}

/**
 * GraphML 1.0 document with fixed key IDs, sorted nodes, sorted edges, and
 * edge IDs derived from their sorted position.
 */
export function renderGraphML(graph: MemoryGraph): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns"',
    '         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '         xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">',
  ];
  for (const [id, name, type] of GRAPH_KEYS) lines.push(key(id, "graph", name, type));
  for (const [id, name, type] of NODE_KEYS) lines.push(key(id, "node", name, type));
  for (const [id, name, type] of EDGE_KEYS) lines.push(key(id, "edge", name, type));
  lines.push('  <graph id="goldfish" edgedefault="directed">');
  lines.push(data("g_schemaVersion", String(graph.schemaVersion)));
  if (graph.projectId) lines.push(data("g_projectId", graph.projectId));

  for (const node of graph.nodes) {
    lines.push(`    <node id="${xmlAttr(node.id)}">`);
    lines.push(data("n_kind", node.kind, "      "));
    lines.push(data("n_title", node.title, "      "));
    lines.push(data("n_body", node.body, "      "));
    lines.push(data("n_status", node.status, "      "));
    lines.push(data("n_basis", node.basis, "      "));
    lines.push(data("n_confidence", String(node.confidence), "      "));
    lines.push(data("n_verification", node.verificationState, "      "));
    lines.push(data("n_version", String(node.version), "      "));
    lines.push(data("n_scope", node.scope.join("\n"), "      "));
    lines.push(data("n_tags", node.tags.join("\n"), "      "));
    lines.push(data("n_created", node.createdAt, "      "));
    lines.push(data("n_updated", node.updatedAt, "      "));
    lines.push(data("n_autoInject", node.autoInjectEligible ? "true" : "false", "      "));
    lines.push("    </node>");
  }

  graph.edges.forEach((edge, index) => {
    lines.push(
      `    <edge id="e${index}" source="${xmlAttr(edge.source)}" target="${xmlAttr(edge.target)}">`,
    );
    lines.push(data("e_type", edge.type, "      "));
    lines.push(data("e_weight", String(edge.weight), "      "));
    lines.push(data("e_created", edge.createdAt, "      "));
    if (edge.retiredAt) lines.push(data("e_retired", edge.retiredAt, "      "));
    lines.push("    </edge>");
  });

  lines.push("  </graph>", "</graphml>");
  return `${lines.join("\n")}\n`;
}
