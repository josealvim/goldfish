import type { MemoryGraph } from "./types.ts";

/**
 * The graph object is constructed with fixed key order by the model, so
 * JSON.stringify is deterministic for a given memory state.
 */
export function renderGraphJson(graph: MemoryGraph): string {
  return `${JSON.stringify(graph, null, 2)}\n`;
}
