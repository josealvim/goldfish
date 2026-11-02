export const NODE_KINDS = [
  "fact",
  "decision",
  "concept",
  "component",
  "pattern",
  "gotcha",
  "runbook",
  "document",
  "source",
  "session",
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export const CLAIM_KINDS = [
  "fact",
  "decision",
  "pattern",
  "gotcha",
  "runbook",
] as const;

export type ClaimKind = (typeof CLAIM_KINDS)[number];

export function isClaimKind(kind: NodeKind): kind is ClaimKind {
  return (CLAIM_KINDS as readonly string[]).includes(kind);
}

export const EDGE_TYPES = [
  "cites",
  "derived_from",
  "supersedes",
  "contradicts",
  "revises",
  "depends_on",
  "part_of",
  "applies_to",
  "related_to",
  "documents",
  "implements",
] as const;

export type EdgeType = (typeof EDGE_TYPES)[number];

export const BASES = ["verified", "cited", "derived", "inferred"] as const;
export type Basis = (typeof BASES)[number];

export const NODE_STATUSES = ["active", "disputed", "stale", "superseded", "archived"] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export const VERIFICATION_STATES = [
  "not_required",
  "unverified",
  "queued",
  "confirmed",
  "rejected",
  "needs_human",
] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];

export const SOURCE_TYPES = [
  "file",
  "commit",
  "pr",
  "issue",
  "url",
  "session",
  "human",
  "doc",
  "test",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export interface Author {
  type: "agent" | "human" | "system";
  id: string;
  sessionID?: string;
}

export interface CitationInput {
  type: SourceType;
  locator: string;
  excerpt?: string;
  metadata?: Record<string, unknown>;
}

export interface Citation extends CitationInput {
  sourceID: string;
  contentHash?: string;
  excerptHash?: string;
  observedAt: string;
  validation: "ok" | "missing" | "unchecked";
}

export interface CitationSnapshot {
  locator: string;
  content: string;
  contentHash: string;
  lineStart: number;
  lineEnd: number;
  truncated: boolean;
  excerptFound: boolean;
  redacted: boolean;
  promptInjectionDetected: boolean;
  skipReason?: string;
}

export interface CitationCheck {
  nodeID: string;
  citation: Citation;
  status: "ok" | "missing" | "changed" | "unchecked";
  snapshot?: CitationSnapshot;
}

export interface MemoryNode {
  id: string;
  kind: NodeKind;
  title: string;
  body: string;
  scope: string[];
  tags: string[];
  status: NodeStatus;
  basis: Basis;
  confidence: number;
  verificationState: VerificationState;
  canonicalKey: string;
  version: number;
  author: Author;
  createdAt: string;
  updatedAt: string;
  lastConfirmedAt?: string;
  validFrom?: string;
  validTo?: string;
  materialRevisionAt?: string;
  autoInjectEligible: boolean;
  metadata: Record<string, unknown>;
}

export interface NodeVersion {
  nodeID: string;
  version: number;
  title: string;
  body: string;
  basis: Basis;
  confidence: number;
  status: NodeStatus;
  verificationState: VerificationState;
  author: Author;
  reason?: string;
  evidence: unknown[];
  createdAt: string;
}

export interface Edge {
  fromID: string;
  toID: string;
  type: EdgeType;
  weight: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  retiredAt?: string;
}

export interface LinkInput {
  to: string;
  type: EdgeType;
  weight?: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryProposal {
  kind: NodeKind;
  title: string;
  body: string;
  scope?: string[];
  tags?: string[];
  citations?: CitationInput[];
  links?: LinkInput[];
  basis?: Basis;
  confidence?: number;
  reason?: string;
  supersedes?: string;
  contradicts?: string[];
  metadata?: Record<string, unknown>;
}

export interface WriteContext {
  author: Author;
  sessionID?: string;
  agent?: string;
  messageID?: string;
  now?: string;
}

export type RememberAction = "created" | "merged" | "revised" | "conflict" | "rejected";

export interface RememberResult {
  action: RememberAction;
  node?: MemoryNode;
  conflicts?: string[];
  reasons?: string[];
}

export interface RecallQuery {
  query: string;
  scope?: string[];
  kinds?: NodeKind[];
  statuses?: NodeStatus[];
  includeInferred?: boolean;
  includeDisputed?: boolean;
  includeStale?: boolean;
  includeArchived?: boolean;
  autoInjectOnly?: boolean;
  limit?: number;
  budgetTokens?: number;
  minScore?: number;
}

export interface MemoryCard {
  id: string;
  kind: NodeKind;
  title: string;
  body: string;
  scope: string[];
  tags: string[];
  status: NodeStatus;
  basis: Basis;
  confidence: number;
  verificationState: VerificationState;
  citations: Citation[];
  related: Array<{ id: string; type: EdgeType }>;
  score: number;
  reasons: string[];
}

export interface RecallResult {
  query: string;
  cards: MemoryCard[];
  candidates: number;
  tokens: number;
  hasMore: boolean;
}

export interface NeighborOptions {
  edgeTypes?: EdgeType[];
  direction?: "out" | "in" | "both";
  depth?: number;
  limit?: number;
}

export interface Neighbor {
  node: MemoryNode;
  edge: Edge;
  direction: "out" | "in";
  depth: number;
}

export interface NeighborResult {
  node: MemoryNode;
  neighbors: Neighbor[];
}

export interface MemoryDetail {
  node: MemoryNode;
  versions: NodeVersion[];
  citations: Citation[];
  edges: Edge[];
  audits: AuditInfo[];
  injections: InjectionInfo[];
}

export interface AuditInfo {
  id: number;
  version: number;
  trigger: string;
  sampledBy: string;
  riskScore: number;
  auditor: Record<string, unknown>;
  outcome: string;
  findings: Record<string, unknown>;
  createdAt: string;
}

export interface InjectionInfo {
  id: number;
  sessionID: string;
  messageID?: string;
  rank: number;
  tokens: number;
  source: string;
  createdAt: string;
}

export interface MemoryListQuery {
  kinds?: NodeKind[];
  statuses?: NodeStatus[];
  bases?: Basis[];
  scope?: string;
  tag?: string;
  limit?: number;
  offset?: number;
}

export interface MemoryListItem {
  id: string;
  kind: NodeKind;
  title: string;
  status: NodeStatus;
  basis: Basis;
  confidence: number;
  verificationState: VerificationState;
  scope: string[];
  tags: string[];
  citationCount: number;
  edgeCount: number;
  updatedAt: string;
}

export interface MemoryListResult {
  total: number;
  items: MemoryListItem[];
  nextOffset?: number;
}

export interface HealthIssue {
  id: string;
  title: string;
  reasons: string[];
}

export interface MemoryHealth {
  generatedAt: string;
  total: number;
  active: number;
  statuses: Record<string, number>;
  bases: Record<string, number>;
  kinds: Record<string, number>;
  onboarding: OnboardingState;
  overview: { present: boolean; linkedComponents: number };
  citationCoverage: number;
  counts: {
    uncited: number;
    stale: number;
    disputed: number;
    orphaned: number;
    lowConfidence: number;
    verificationBacklog: number;
    auditBacklog: number;
    renamedIds: number;
    ratificationSuggested: number;
    conflictProposals: number;
  };
  uncited: HealthIssue[];
  stale: HealthIssue[];
  disputed: HealthIssue[];
  orphaned: HealthIssue[];
  lowConfidence: HealthIssue[];
  verificationBacklog: HealthIssue[];
  auditBacklog: HealthIssue[];
  renamedIds: HealthIssue[];
  ratificationSuggested: HealthIssue[];
  conflictProposals: HealthIssue[];
}

export interface VerificationAuditInput {
  trigger: "verification" | "uniform" | "risk" | "dispute" | "stale" | "manual";
  outcome: AuditRecordInput["outcome"];
  sampledBy?: string;
  riskScore?: number;
  auditor?: Record<string, unknown>;
  findings?: Record<string, unknown>;
}

export interface ApplyVerificationInput {
  basis?: Basis;
  verificationState?: VerificationState;
  status?: NodeStatus;
  confidence?: number;
  lastConfirmedAt?: string;
  metadata?: Record<string, unknown>;
  audit: VerificationAuditInput;
  conflictIDs?: string[];
  author: Author;
  reason: string;
}

export interface MemoryStats {
  nodes: Record<string, number>;
  statuses: Record<string, number>;
  bases: Record<string, number>;
  kinds: Record<string, number>;
  verification: Record<string, number>;
  events: number;
  injections: number;
  audits: number;
}

export type OnboardingState = "empty" | "recommended" | "partial" | "complete";

export interface MemoryStatus {
  total: number;
  kinds: Record<string, number>;
  bases: Record<string, number>;
  statuses: Record<string, number>;
  overview: boolean;
  state: OnboardingState;
  onboardingRecommended: boolean;
}

export interface ReviewItem {
  node: MemoryNode;
  reasons: string[];
}

export type ConflictRelation = "contradicts";
export type ConflictStatus = "proposed" | "confirmed" | "dismissed" | "stale";

export interface ConflictEvidence {
  locator: string;
  quote: string;
  why?: string;
}

export interface ConflictFinding {
  candidateID: string;
  relation: ConflictRelation;
  reason: string;
  evidence: ConflictEvidence[];
}

export interface ConflictProposal {
  id: number;
  nodeA: MemoryNode;
  nodeB: MemoryNode;
  nodeAVersion: number;
  nodeBVersion: number;
  status: ConflictStatus;
  relation: ConflictRelation;
  reason: string;
  evidence: ConflictEvidence[];
  inputHash: string;
  createdAt: string;
  updatedAt: string;
  stale: boolean;
}

export interface ConflictProposalInput {
  nodeA: string;
  nodeB: string;
  nodeAVersion: number;
  nodeBVersion: number;
  relation: ConflictRelation;
  reason: string;
  evidence: ConflictEvidence[];
  inputHash: string;
}

export interface AuditCandidate {
  node: MemoryNode;
  trigger: "uniform" | "risk";
  riskScore: number;
  reasons: string[];
}

export interface AuditRecordInput {
  nodeID: string;
  version: number;
  trigger: "uniform" | "risk" | "dispute" | "stale" | "verification" | "manual";
  outcome:
    | "supported"
    | "partially_supported"
    | "contradicted"
    | "insufficient"
    | "stale"
    | "malicious"
    | "confirmed"
    | "rejected"
    | "needs_human"
    | "no_conflict"
    | "conflict_proposed";
  auditor?: Record<string, unknown>;
  findings?: Record<string, unknown>;
  sampledBy?: string;
  riskScore?: number;
}

export interface ExportBundle {
  schemaVersion: number;
  exportedAt: string;
  projectRoot: string;
  nodes: MemoryNode[];
  versions: unknown[];
  edges: unknown[];
  sources: unknown[];
  citations: unknown[];
}
