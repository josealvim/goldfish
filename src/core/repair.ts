import type {
  AuditInfo,
  Citation,
  CitationCheck,
  ConflictProposal,
  MemoryNode,
  Neighbor,
  NodeVersion,
} from "./types.ts";
import type { MemoryStore } from "./store.ts";
import { baseNodeId } from "./ids.ts";
import { displayScope } from "./glob.ts";
import { buildVerificationPacket } from "./verification.ts";

export type RepairTier =
  | "none"
  | "metadata"
  | "agent_content"
  | "human_authority"
  | "incident";

export type RepairActionKind =
  | "update_metadata"
  | "recite"
  | "revise"
  | "replace"
  | "confirm_cited"
  | "confirm_derived"
  | "confirm_verified"
  | "reject"
  | "archive"
  | "leave_for_review";

export interface RepairAction {
  action: RepairActionKind;
  tier: RepairTier;
  reason: string;
}

export interface RepairPacket {
  node: MemoryNode;
  citations: Citation[];
  citationChecks: CitationCheck[];
  versions: NodeVersion[];
  audits: AuditInfo[];
  neighbors: Neighbor[];
  conflicts: ConflictProposal[];
  deterministic: {
    ok: boolean;
    stale: boolean;
    reasons: string[];
    warnings: string[];
  };
  suggestedTier: RepairTier;
  actions: RepairAction[];
}

const TIER_RANK: Record<RepairTier, number> = {
  none: 0,
  metadata: 1,
  agent_content: 2,
  human_authority: 3,
  incident: 4,
};

export function buildRepairPacket(
  store: MemoryStore,
  id: string,
): RepairPacket | undefined {
  const detail = store.get(id);
  if (!detail) return undefined;
  const node = detail.node;
  const citationChecks = store.citationChecks(id);
  const verification = buildVerificationPacket(store, id, {
    readSources: false,
    maxCitations: 50,
    maxPremises: 50,
    maxConflicts: 50,
    maxContext: 50,
    maxHistory: 50,
  });
  const deterministic = verification?.deterministic ?? {
    ok: true,
    stale: false,
    reasons: [],
    warnings: [],
  };
  const neighbors = store.neighbors(id, { depth: 1, limit: 20 })?.neighbors ?? [];
  const conflicts = store
    .conflictProposals({ limit: 200 })
    .filter(
      (proposal) =>
        proposal.nodeA.id === id || proposal.nodeB.id === id,
    );

  const actions = new Map<RepairActionKind, RepairAction>();
  const add = (action: RepairActionKind, tier: RepairTier, reason: string): void => {
    const existing = actions.get(action);
    if (!existing) {
      actions.set(action, { action, tier, reason });
      return;
    }
    if (TIER_RANK[tier] > TIER_RANK[existing.tier]) existing.tier = tier;
    if (!existing.reason.includes(reason)) {
      existing.reason = `${existing.reason}; ${reason}`;
    }
  };

  const changed = citationChecks.filter(
    (check) => check.status === "missing" || check.status === "changed",
  );
  if (node.status === "stale" || changed.length || deterministic.stale) {
    add("recite", "agent_content", "Current citations are stale, changed, or missing.");
    add("revise", "agent_content", "Create a new claim version with current evidence.");
  }
  if (node.status === "disputed") {
    add("revise", "human_authority", "The claim is disputed and needs a versioned correction.");
    add("archive", "human_authority", "Archive the claim if it cannot be corrected.");
  }
  const confirmedConflicts = conflicts.filter(
    (proposal) => proposal.status === "confirmed" && !proposal.stale,
  );
  if (confirmedConflicts.length) {
    add("revise", "human_authority", "A confirmed conflict requires a human decision.");
    add("archive", "human_authority", "Archive only if the claim is intentionally withdrawn.");
  }
  if (node.verificationState === "rejected") {
    add("revise", "human_authority", "The claim was rejected and should not be reused as-is.");
    add("archive", "human_authority", "Archive the rejected claim if no repair is planned.");
  }
  if (node.verificationState === "needs_human") {
    add("leave_for_review", "human_authority", "Verification could not settle the claim.");
  }
  if (node.metadata.ratificationSuggested) {
    add(
      "confirm_verified",
      "human_authority",
      "A model suggested ratification; only an explicit human can verify.",
    );
  }
  if (node.basis === "inferred") {
    if (citationChecks.length && !changed.length) {
      add("confirm_cited", "agent_content", "Fresh source evidence can support a cited confirmation.");
      if (
        citationChecks.some(
          (check) =>
            check.citation.type === "human" ||
            check.citation.type === "test" ||
            check.citation.type === "commit",
        )
      ) {
        add(
          "confirm_verified",
          "human_authority",
          "Human, test, or commit evidence can support explicit verification.",
        );
      }
    } else {
      add("recite", "agent_content", "Add current source evidence before promotion.");
      add("reject", "human_authority", "Reject the claim if no evidence can support it.");
    }
  }
  if (node.basis === "derived") {
    const unsound = verification?.premises.filter((premise) => !premise.sound) ?? [];
    const circular = deterministic.reasons.some((reason) =>
      reason.includes("circular derived_from chain"),
    );
    if (!verification?.premises.length || unsound.length || circular) {
      add("revise", "human_authority", "Derived premises are missing, unsound, or circular.");
      add("reject", "human_authority", "Reject the derivation if the premises cannot support it.");
    } else {
      add("confirm_derived", "agent_content", "Premises are sound and can support a derived confirmation.");
    }
  }
  if (node.id !== baseNodeId(node.kind, node.title)) {
    add("update_metadata", "metadata", "The node ID no longer matches the title slug.");
  }
  if (!actions.size) {
    add("leave_for_review", "none", "No deterministic repair action is required.");
  }

  const ordered = [...actions.values()].sort(
    (left, right) =>
      TIER_RANK[right.tier] - TIER_RANK[left.tier] ||
      left.action.localeCompare(right.action),
  );
  const suggestedTier = ordered.reduce<RepairTier>(
    (current, action) =>
      TIER_RANK[action.tier] > TIER_RANK[current] ? action.tier : current,
    "none",
  );

  return {
    node,
    citations: detail.citations,
    citationChecks,
    versions: detail.versions,
    audits: detail.audits,
    neighbors,
    conflicts,
    deterministic,
    suggestedTier,
    actions: ordered,
  };
}

function tierLabel(tier: RepairTier): string {
  return tier.replaceAll("_", " ");
}

export function formatRepairPacket(packet: RepairPacket): string {
  const node = packet.node;
  const lines = [
    `# Repair packet: ${node.title}`,
    `ID: ${node.id}`,
    `Kind: ${node.kind} · Basis: ${node.basis} · Status: ${node.status}`,
    `Verification: ${node.verificationState} · Auto-inject: ${node.autoInjectEligible ? "yes" : "no"}`,
    `Scope: ${displayScope(node.scope)} · Version: ${node.version}`,
    `Suggested tier: ${tierLabel(packet.suggestedTier)}`,
    "",
    node.body,
    "",
    "## Suggested actions",
  ];
  for (const action of packet.actions) {
    lines.push(`- [${tierLabel(action.tier)}] ${action.action} — ${action.reason}`);
  }
  if (packet.deterministic.reasons.length) {
    lines.push("", "## Deterministic findings");
    for (const reason of packet.deterministic.reasons) lines.push(`- ${reason}`);
  }
  if (packet.deterministic.warnings.length) {
    lines.push("", "## Warnings");
    for (const warning of packet.deterministic.warnings) lines.push(`- ${warning}`);
  }
  if (packet.citationChecks.length) {
    lines.push("", "## Citations");
    for (const check of packet.citationChecks) {
      const excerpt = check.citation.excerpt
        ? ` — "${check.citation.excerpt.slice(0, 160)}"`
        : "";
      lines.push(`- ${check.citation.type}:${check.citation.locator} [${check.status}]${excerpt}`);
    }
  }
  if (packet.conflicts.length) {
    lines.push("", "## Conflicts");
    for (const conflict of packet.conflicts) {
      const other =
        conflict.nodeA.id === node.id ? conflict.nodeB.id : conflict.nodeA.id;
      lines.push(
        `- ${other} [${conflict.status}${conflict.stale ? ", stale" : ""}] ${conflict.reason}`,
      );
    }
  }
  if (packet.neighbors.length) {
    lines.push("", "## Neighbors");
    for (const neighbor of packet.neighbors.slice(0, 10)) {
      lines.push(
        `- ${neighbor.node.id} --${neighbor.edge.type}--> ${neighbor.direction}`,
      );
    }
  }
  if (packet.versions.length) {
    lines.push("", "## Versions");
    for (const version of packet.versions.slice(0, 8)) {
      lines.push(
        `- v${version.version}: ${version.status}/${version.basis} — ${version.reason ?? "revision"} (${version.createdAt})`,
      );
    }
  }
  if (packet.audits.length) {
    lines.push("", "## Audits");
    for (const audit of packet.audits.slice(0, 8)) {
      lines.push(
        `- ${audit.createdAt} · v${audit.version} · ${audit.trigger} · ${audit.outcome} · ${audit.sampledBy}`,
      );
    }
  }
  lines.push(
    "",
    "This packet is read-only. Apply one action only after explicit user approval.",
  );
  return lines.join("\n");
}
