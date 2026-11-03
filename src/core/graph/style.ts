import type { EdgeType, NodeKind, NodeStatus } from "../types.ts";

export const KIND_COLORS: Record<NodeKind, string> = {
  fact: "#2563eb",
  decision: "#7c3aed",
  concept: "#0891b2",
  component: "#059669",
  pattern: "#d97706",
  gotcha: "#dc2626",
  runbook: "#0d9488",
  document: "#64748b",
  source: "#9333ea",
  session: "#65a30d",
};

export const EDGE_COLORS: Record<EdgeType, string> = {
  cites: "#94a3b8",
  derived_from: "#0ea5e9",
  supersedes: "#f97316",
  contradicts: "#dc2626",
  revises: "#a855f7",
  depends_on: "#6366f1",
  part_of: "#10b981",
  applies_to: "#14b8a6",
  related_to: "#64748b",
  documents: "#8b5cf6",
  implements: "#22c55e",
};

export const STATUS_STROKES: Record<NodeStatus, string> = {
  active: "#ffffff",
  disputed: "#dc2626",
  stale: "#d97706",
  superseded: "#94a3b8",
  archived: "#cbd5e1",
};

export const STATUS_OPACITY: Record<NodeStatus, number> = {
  active: 1,
  disputed: 1,
  stale: 0.92,
  superseded: 0.45,
  archived: 0.25,
};
