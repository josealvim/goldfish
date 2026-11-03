import type {
  Basis,
  Edge,
  EdgeType,
  MemoryNode,
  NodeKind,
  NodeStatus,
  VerificationState,
} from "../types.ts";

export const GRAPH_FORMATS = ["json", "graphml", "dot", "html"] as const;
export type GraphFormat = (typeof GRAPH_FORMATS)[number];

export interface MemoryGraphNode {
  id: string;
  kind: NodeKind;
  title: string;
  body: string;
  status: NodeStatus;
  basis: Basis;
  confidence: number;
  verificationState: VerificationState;
  version: number;
  scope: string[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
  autoInjectEligible: boolean;
}

export interface MemoryGraphEdge {
  source: string;
  target: string;
  type: EdgeType;
  weight: number;
  createdAt: string;
  retiredAt?: string;
}

export interface MemoryGraph {
  schemaVersion: 1;
  projectId?: string;
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
}

/**
 * Raw graph input supplied by the store. Projection, filtering, and sorting
 * belong to the graph module, not to storage.
 */
export interface MemoryGraphSnapshot {
  projectId?: string;
  nodes: MemoryNode[];
  edges: Edge[];
}

export interface BuildGraphOptions {
  activeOnly?: boolean;
  includeRetired?: boolean;
}

export interface GraphLayoutPosition {
  x: number;
  y: number;
}

export type GraphLayout = Record<string, GraphLayoutPosition>;
