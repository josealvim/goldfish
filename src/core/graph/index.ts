import path from "node:path";
import { renderDot } from "./dot.ts";
import { renderGraphML } from "./graphml.ts";
import { renderGraphHtml } from "./html.ts";
import { renderGraphJson } from "./json.ts";
import type { GraphFormat, MemoryGraph } from "./types.ts";

export {
  GRAPH_FORMATS,
  type BuildGraphOptions,
  type GraphFormat,
  type GraphLayout,
  type MemoryGraph,
  type MemoryGraphEdge,
  type MemoryGraphNode,
  type MemoryGraphSnapshot,
} from "./types.ts";
export { buildMemoryGraph, compareGraphText } from "./model.ts";
export { layoutGraph } from "./layout.ts";

export function renderGraph(graph: MemoryGraph, format: GraphFormat): string {
  switch (format) {
    case "json":
      return renderGraphJson(graph);
    case "graphml":
      return renderGraphML(graph);
    case "dot":
      return renderDot(graph);
    case "html":
      return renderGraphHtml(graph);
    default:
      throw new Error(`Unknown graph format: ${String(format)}`);
  }
}

export function inferGraphFormat(target?: string): GraphFormat | undefined {
  if (!target) return undefined;
  const extension = path.extname(target).toLowerCase();
  switch (extension) {
    case ".json":
      return "json";
    case ".graphml":
      return "graphml";
    case ".dot":
    case ".gv":
      return "dot";
    case ".html":
    case ".htm":
      return "html";
    default:
      return undefined;
  }
}

export function isGraphFormat(value: string): value is GraphFormat {
  return value === "json" || value === "graphml" || value === "dot" || value === "html";
}
