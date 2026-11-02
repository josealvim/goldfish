import type { Registration } from "@opencode/plugin/promise/registration";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import {
  formatAuditCandidates,
  formatMemoryHealth,
  formatMemoryList,
  formatMemoryStatus,
  formatNeighbors,
  formatNode,
  formatRecall,
  formatRemember,
  formatReview,
} from "../core/format.ts";
import {
  applyVerificationVerdict,
  buildVerificationPacket,
  findCachedVerification,
  verificationInputHash,
} from "../core/verification.ts";
import { BASES, EDGE_TYPES, NODE_KINDS, NODE_STATUSES, SOURCE_TYPES } from "../core/types.ts";
import type {
  AuditRecordInput,
  Basis,
  CitationInput,
  EdgeType,
  MemoryProposal,
  NeighborOptions,
  NodeKind,
  NodeStatus,
  RecallQuery,
} from "../core/types.ts";
import type { PluginContext, Runtime } from "./runtime.ts";

interface RecallInput {
  query: string;
  scope?: string[];
  kinds?: NodeKind[];
  limit?: number;
  budgetTokens?: number;
  includeInferred?: boolean;
  includeDisputed?: boolean;
  includeStale?: boolean;
  autoInjectOnly?: boolean;
}

interface RememberInput extends MemoryProposal {}

interface GetInput {
  id: string;
}

interface NeighborsInput {
  id: string;
  edgeTypes?: EdgeType[];
  direction?: "out" | "in" | "both";
  depth?: number;
  limit?: number;
}

interface ListInput {
  kinds?: NodeKind[];
  statuses?: NodeStatus[];
  bases?: Basis[];
  scope?: string;
  tag?: string;
  limit?: number;
  offset?: number;
}

interface CiteInput {
  id: string;
  citations: CitationInput[];
  reason?: string;
}

interface AdminLinkInput {
  from: string;
  to: string;
  type: EdgeType;
  weight?: number;
}

interface UnlinkInput {
  from: string;
  to: string;
  type: EdgeType;
}

interface UpdateInput {
  id: string;
  title?: string;
  scope?: string[];
  tags?: string[];
  reason?: string;
}

interface ArchiveInput {
  id: string;
  reason: string;
}

interface VerifyInput {
  ids?: string[];
  scope?: string;
  limit?: number;
}

interface ReviewInput {
  limit?: number;
}

interface AuditInput {
  mode: "candidates" | "run" | "record";
  limit?: number;
  uniformRate?: number;
  riskRate?: number;
  id?: string;
  outcome?: AuditRecordInput["outcome"];
  trigger?: AuditRecordInput["trigger"];
  reason?: string;
}

const recallSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Natural-language or keyword query about the project.",
    },
    scope: {
      type: "array",
      items: { type: "string" },
      description: "Repo-relative paths or globs for the area being worked on.",
    },
    kinds: {
      type: "array",
      items: { type: "string", enum: [...NODE_KINDS] },
      description: "Restrict results to these node kinds.",
    },
    limit: { type: "integer", minimum: 1, maximum: 20 },
    budgetTokens: { type: "integer", minimum: 100, maximum: 4000 },
    includeInferred: {
      type: "boolean",
      description: "Include unverified inferred claims. Defaults to true for explicit recall.",
    },
    includeDisputed: {
      type: "boolean",
      description: "Include claims whose sources conflict. Defaults to false.",
    },
    includeStale: {
      type: "boolean",
      description: "Include claims whose cited sources changed. Defaults to false.",
    },
    autoInjectOnly: {
      type: "boolean",
      description: "Apply the auto-injection policy. Mostly useful for debugging.",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

const citationSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: [...SOURCE_TYPES] },
    locator: {
      type: "string",
      description: "Repo-relative file path, commit SHA, PR/issue URL, or session/message ID.",
    },
    excerpt: {
      type: "string",
      description: "Short supporting quote. Never include secrets.",
    },
    metadata: { type: "object", additionalProperties: true },
  },
  required: ["type", "locator"],
  additionalProperties: false,
} as const;

const rememberSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: [...NODE_KINDS] },
    title: { type: "string", description: "Specific, stable claim title." },
    body: {
      type: "string",
      description:
        "Concise claim, rationale, or relationship. Do not paste code; cite the source instead.",
    },
    scope: {
      type: "array",
      items: { type: "string" },
      description: "Repo-relative paths, packages, or services this applies to.",
    },
    tags: { type: "array", items: { type: "string" } },
    citations: {
      type: "array",
      items: citationSchema,
      description: "Evidence for the claim. Required for cited or verified claims.",
    },
    links: {
      type: "array",
      items: {
        type: "object",
        properties: {
          to: { type: "string" },
          type: { type: "string", enum: [...EDGE_TYPES] },
          weight: { type: "number" },
          metadata: { type: "object", additionalProperties: true },
        },
        required: ["to", "type"],
        additionalProperties: false,
      },
    },
    basis: {
      type: "string",
      enum: ["verified", "cited", "derived", "inferred"],
      description:
        "verified requires human/test/commit evidence; cited requires a valid source; derived requires verified/cited premises linked with derived_from; inferred is unverified.",
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    supersedes: {
      type: "string",
      description: "ID of an existing claim this one intentionally replaces.",
    },
    contradicts: {
      type: "array",
      items: { type: "string" },
      description: "IDs of existing claims this one contradicts.",
    },
    metadata: { type: "object", additionalProperties: true },
  },
  required: ["kind", "title", "body"],
  additionalProperties: false,
} as const;

const getSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Memory node ID, such as decision/outbox-for-billing." },
  },
  required: ["id"],
  additionalProperties: false,
} as const;

const neighborsSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    edgeTypes: {
      type: "array",
      items: { type: "string", enum: [...EDGE_TYPES] },
    },
    direction: { type: "string", enum: ["out", "in", "both"] },
    depth: { type: "integer", minimum: 1, maximum: 2 },
    limit: { type: "integer", minimum: 1, maximum: 100 },
  },
  required: ["id"],
  additionalProperties: false,
} as const;

const statusSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const listSchema = {
  type: "object",
  properties: {
    kinds: { type: "array", items: { type: "string", enum: [...NODE_KINDS] } },
    statuses: { type: "array", items: { type: "string", enum: [...NODE_STATUSES] } },
    bases: { type: "array", items: { type: "string", enum: [...BASES] } },
    scope: { type: "string", description: "Repo-relative path or glob." },
    tag: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 100 },
    offset: { type: "integer", minimum: 0 },
  },
  additionalProperties: false,
} as const;

const healthSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const citeSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Memory node ID." },
    citations: { type: "array", items: citationSchema, minItems: 1 },
    reason: { type: "string" },
  },
  required: ["id", "citations"],
  additionalProperties: false,
} as const;

const adminLinkSchema = {
  type: "object",
  properties: {
    from: { type: "string" },
    to: { type: "string" },
    type: { type: "string", enum: [...EDGE_TYPES] },
    weight: { type: "number" },
  },
  required: ["from", "to", "type"],
  additionalProperties: false,
} as const;

const unlinkSchema = {
  type: "object",
  properties: {
    from: { type: "string" },
    to: { type: "string" },
    type: { type: "string", enum: [...EDGE_TYPES] },
  },
  required: ["from", "to", "type"],
  additionalProperties: false,
} as const;

const updateSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    scope: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
  },
  required: ["id"],
  additionalProperties: false,
} as const;

const archiveSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    reason: { type: "string" },
  },
  required: ["id", "reason"],
  additionalProperties: false,
} as const;

const verifySchema = {
  type: "object",
  properties: {
    ids: { type: "array", items: { type: "string" } },
    scope: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 20 },
  },
  additionalProperties: false,
} as const;

const reviewSchema = {
  type: "object",
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 100 },
  },
  additionalProperties: false,
} as const;

const auditSchema = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["candidates", "run", "record"] },
    limit: { type: "integer", minimum: 1, maximum: 100 },
    uniformRate: { type: "number", minimum: 0, maximum: 1 },
    riskRate: { type: "number", minimum: 0, maximum: 1 },
    id: { type: "string", description: "Node ID for mode=record." },
    outcome: {
      type: "string",
      enum: [
        "supported",
        "partially_supported",
        "contradicted",
        "insufficient",
        "stale",
        "malicious",
        "confirmed",
        "rejected",
        "needs_human",
      ],
    },
    trigger: {
      type: "string",
      enum: ["uniform", "risk", "dispute", "stale", "verification", "manual"],
    },
    reason: { type: "string" },
  },
  required: ["mode"],
  additionalProperties: false,
} as const;

export async function registerTools(ctx: PluginContext, runtime: Runtime): Promise<Registration> {
  return ctx.tool.transform((editor) => {
    editor.namespace({
      name: "memory",
      description: "Local project knowledge: decisions, gotchas, patterns, components, and sources.",
    });

    editor.add({
      name: "recall",
      description:
        "Search the project's local memory for decisions, gotchas, patterns, components, docs, and past learnings. " +
        "Use before planning unfamiliar work or when the user references prior context. " +
        "Returns compact evidence cards with citations. Memory is evidence, not authority: verify against current " +
        "sources before editing. Explicit recall includes inferred claims by default; disputed and stale claims " +
        "require explicit inclusion.",
      input: recallSchema,
      options: { namespace: "memory", codemode: false },
      execute: async (raw, context) => {
        const input = raw as unknown as RecallInput;
        const query: RecallQuery = {
          query: input.query,
          scope: input.scope,
          kinds: input.kinds,
          limit: input.limit,
          budgetTokens: input.budgetTokens,
          includeInferred: input.includeInferred ?? true,
          includeDisputed: input.includeDisputed ?? false,
          includeStale: input.includeStale ?? false,
          autoInjectOnly: input.autoInjectOnly ?? false,
        };
        const result = runtime.store.recall(query);
        try {
          runtime.store.recordInjections(
            String(context.sessionID),
            String(context.messageID),
            result.cards,
            "tool",
          );
        } catch (error) {
          console.error("project-memory: failed to record recall injection", error);
        }
        return {
          content: formatRecall(result),
          metadata: {
            count: result.cards.length,
            candidates: result.candidates,
            tokens: result.tokens,
          },
        };
      },
    });

    editor.add({
      name: "remember",
      description:
        "Propose a durable, non-obvious project claim. Use for decisions and rationale, gotchas, patterns, " +
        "component relationships, and source-backed facts. Do not store code dumps, secrets, or transient task " +
        "state. Include citations with exact file, commit, PR, issue, or session locators. Inferred claims are " +
        "accepted immediately but require independent verification before automatic injection.",
      input: rememberSchema,
      options: { namespace: "memory", codemode: false },
      execute: async (raw, context) => {
        const input = raw as unknown as RememberInput;
        if (runtime.requireWritePermission) {
          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            action: "memory.remember",
            resources: [input.kind, ...(input.scope ?? [])],
            source: { type: "tool", messageID: context.messageID, id: context.id },
          });
        }
        const result = runtime.store.remember(input, {
          author: {
            type: "agent",
            id: String(context.agent),
            sessionID: String(context.sessionID),
          },
          agent: String(context.agent),
          sessionID: String(context.sessionID),
          messageID: String(context.messageID),
        });
        return {
          content: formatRemember(result),
          metadata: {
            action: result.action,
            ...(result.node
              ? { nodeID: result.node.id, autoInjectEligible: result.node.autoInjectEligible }
              : {}),
          },
        };
      },
    });

    editor.add({
      name: "get",
      description:
        "Read a memory node in full, including its citations, relationships, and version history. " +
        "Use after memory_recall when a card looks relevant but you need details or provenance.",
      input: getSchema,
      options: { namespace: "memory", codemode: false },
      execute: async (raw) => {
        const input = raw as unknown as GetInput;
        const detail = runtime.store.get(input.id);
        return {
          content: detail ? formatNode(detail) : `No memory node found for ${input.id}.`,
          metadata: detail ? { found: true, nodeID: detail.node.id } : { found: false },
        };
      },
    });

    editor.add({
      name: "neighbors",
      description:
        "Walk the project knowledge graph from a memory node. Use for follow-up questions about dependencies, " +
        "related decisions, affected components, or conflicting claims.",
      input: neighborsSchema,
      options: { namespace: "memory", codemode: false },
      execute: async (raw) => {
        const input = raw as unknown as NeighborsInput;
        const options: NeighborOptions = {
          edgeTypes: input.edgeTypes,
          direction: input.direction ?? "both",
          depth: input.depth ?? 1,
          limit: input.limit ?? 40,
        };
        const result = runtime.store.neighbors(input.id, options);
        return {
          content: result ? formatNeighbors(result) : `No memory node found for ${input.id}.`,
          metadata: result ? { found: true, count: result.neighbors.length } : { found: false },
        };
      },
    });

    editor.add({
      name: "status",
      description:
        "Show project memory coverage and whether onboarding is recommended. Use before a large planning " +
        "task or when checking whether the project has been onboarded. Reports counts by kind, basis, and " +
        "status, plus the fixed project-overview node.",
      input: statusSchema,
      options: { namespace: "memory", codemode: false },
      execute: async () => {
        const status = runtime.store.status();
        return {
          content: formatMemoryStatus(status),
          metadata: status,
        };
      },
    });

    editor.add({
      name: "list",
      description:
        "List memory nodes with filters. Use to enumerate components, uncited claims, stale nodes, or a scope. " +
        "Read-only; use memory_recall for ranked search and memory_health for diagnostics.",
      input: listSchema,
      options: { namespace: "memory", codemode: false },
      execute: async (raw) => {
        const input = (raw ?? {}) as unknown as ListInput;
        const result = runtime.store.list({
          kinds: input.kinds,
          statuses: input.statuses,
          bases: input.bases,
          scope: input.scope,
          tag: input.tag,
          limit: input.limit,
          offset: input.offset,
        });
        return {
          content: formatMemoryList(result),
          metadata: {
            total: result.total,
            returned: result.items.length,
            ...(result.nextOffset !== undefined ? { nextOffset: result.nextOffset } : {}),
          },
        };
      },
    });

    editor.add({
      name: "health",
      description:
        "Show memory health with actionable IDs: uncited, stale, disputed, orphaned, low-confidence, " +
        "verification backlog, audit backlog, renamed IDs, overview linkage, and citation coverage.",
      input: healthSchema,
      options: { namespace: "memory", codemode: false },
      execute: async () => {
        const health = runtime.store.health();
        return {
          content: formatMemoryHealth(health),
          metadata: health,
        };
      },
    });

    editor.add({
      name: "verify",
      description:
        "Verify inferred or unverified claims. Runs deterministic checks, then a rejection-leaning semantic " +
        "verifier when a model is configured. May promote to cited/derived, queue for human review, mark stale, " +
        "or flag conflicts. It never promotes to verified; it may suggest ratification.",
      input: verifySchema,
      options: { namespace: "memory", codemode: false },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as VerifyInput;
        const limit = Math.max(
          1,
          Math.min(input.limit ?? runtime.verificationMaxPerRun, runtime.verificationMaxPerRun),
        );
        const nodes = input.ids?.length
          ? input.ids.flatMap((id) => {
              const detail = runtime.store.get(id);
              return detail ? [detail.node] : [];
            })
          : runtime.store.verificationCandidates({ scope: input.scope, limit });
        const selected = nodes.slice(0, limit);
        if (selected.length) {
          await assertWrite(
            ctx,
            runtime,
            context,
            "memory.verify",
            selected.map((node) => node.id),
          );
        }
        const results: Array<Record<string, unknown>> = [];
        const author = writeContext(context).author;
        const cacheSalt = runtime.verificationModel ?? "session";

        for (const node of selected) {
          const packet = buildVerificationPacket(runtime.store, node.id);
          if (!packet) continue;
          const inputHash = verificationInputHash(packet, cacheSalt);
          if (runtime.verificationSemantic && !packet.deterministic.stale) {
            const cached = findCachedVerification(packet, inputHash);
            if (cached) {
              const findings = cached.findings ?? {};
              results.push({
                id: node.id,
                verdict: findings.verdict ?? cached.outcome,
                action: findings.suggestedAction ?? "cached",
                basis: node.basis,
                status: node.status,
                reason: findings.reason ?? "Cached verification result.",
                cached: true,
              });
              continue;
            }
          }

          const verdict = await runtime.verifier.verify(packet);
          if (verdict.verdict === "needs_model") {
            results.push({
              id: node.id,
              verdict: verdict.verdict,
              action: verdict.suggestedAction,
              basis: node.basis,
              status: node.status,
              reason: verdict.reason,
              applied: false,
            });
            continue;
          }
          const applied = applyVerificationVerdict(runtime.store, packet, verdict, {
            author,
            trigger: "verification",
            sampledBy: "memory_verify",
            auditor: { tool: "memory_verify" },
            cacheSalt,
          });
          results.push({
            id: node.id,
            verdict: verdict.verdict,
            action: verdict.suggestedAction,
            basis: applied.basis,
            status: applied.status,
            reason: verdict.reason,
            applied: true,
          });
        }

        if (!results.length) {
          return {
            content:
              "No verification candidates matched. Use memory_audit for auto-inject-eligible claims " +
              "or pass explicit IDs.",
            metadata: { checked: 0, results: [] },
          };
        }
        const lines = [`Verification run: ${results.length} candidate(s)`, ""];
        for (const result of results) {
          const suffix = result.cached
            ? " (cached)"
            : result.applied === false
              ? " (not applied)"
              : "";
          lines.push(
            `- ${String(result.id)}: ${String(result.verdict)} → ${String(result.basis)}/${String(result.status)}` +
              `${suffix} — ${String(result.reason)}`,
          );
        }
        return {
          content: lines.join("\n"),
          metadata: { checked: results.length, results },
        };
      },
    });

    editor.add({
      name: "review",
      description:
        "Show the memory review queue: inferred/derived claims awaiting verification, needs-human items, " +
        "disputed or stale claims, rejected nodes, and suggested verified ratifications. Read-only.",
      input: reviewSchema,
      options: { namespace: "memory", codemode: false },
      execute: async (raw) => {
        const input = (raw ?? {}) as ReviewInput;
        const items = runtime.store.review().slice(0, input.limit ?? 50);
        return {
          content: formatReview(items),
          metadata: { count: items.length, ids: items.map((item) => item.node.id) },
        };
      },
    });

    editor.add({
      name: "audit",
      description:
        "Sample auto-inject-eligible claims for audit, run deterministic plus semantic checks, or record an " +
        "external audit outcome. Sampling uses a uniform rate plus risk-weighted slots. Audits can mark claims " +
        "stale, disputed, archived, or needs-human; they never automatically resolve a conflict.",
      input: auditSchema,
      options: { namespace: "memory", codemode: false },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as AuditInput;
        if (input.mode === "record") {
          if (!input.id || !input.outcome) {
            throw new Error("mode=record requires id and outcome");
          }
          await assertWrite(ctx, runtime, context, "memory.audit", [input.id]);
          const detail = runtime.store.get(input.id);
          if (!detail) throw new Error(`No memory node found for ${input.id}`);
          runtime.store.recordAudit({
            nodeID: detail.node.id,
            version: detail.node.version,
            trigger: input.trigger ?? "manual",
            outcome: input.outcome,
            sampledBy: "memory_audit",
            riskScore: 0,
            auditor: { tool: "memory_audit" },
            findings: { reason: input.reason ?? "" },
          });
          const updated = runtime.store.get(input.id)?.node;
          return {
            content: `Recorded ${input.outcome} audit for ${input.id}.`,
            metadata: {
              nodeID: input.id,
              outcome: input.outcome,
              status: updated?.status,
              verificationState: updated?.verificationState,
            },
          };
        }

        const limit = Math.max(
          1,
          Math.min(input.limit ?? runtime.auditMaxPerRun, runtime.auditMaxPerRun),
        );
        const candidates = runtime.store.auditCandidates({
          uniformRate: input.uniformRate ?? runtime.auditUniformRate,
          riskRate: input.riskRate ?? runtime.auditRiskRate,
          max: limit,
        });
        if (input.mode === "candidates") {
          return {
            content: formatAuditCandidates(candidates),
            metadata: {
              count: candidates.length,
              ids: candidates.map((candidate) => candidate.node.id),
            },
          };
        }
        if (!candidates.length) {
          return {
            content: "No audit candidates were sampled for this run.",
            metadata: { checked: 0, results: [] },
          };
        }

        await assertWrite(
          ctx,
          runtime,
          context,
          "memory.audit",
          candidates.map((candidate) => candidate.node.id),
        );
        const author = writeContext(context).author;
        const cacheSalt = runtime.verificationModel ?? "session";
        const results: Array<Record<string, unknown>> = [];
        for (const candidate of candidates) {
          const packet = buildVerificationPacket(runtime.store, candidate.node.id);
          if (!packet) continue;
          const inputHash = verificationInputHash(packet, cacheSalt);
          if (runtime.verificationSemantic && !packet.deterministic.stale) {
            const cached = findCachedVerification(packet, inputHash);
            if (cached) {
              const findings = cached.findings ?? {};
              results.push({
                id: candidate.node.id,
                trigger: candidate.trigger,
                riskScore: candidate.riskScore,
                verdict: findings.verdict ?? cached.outcome,
                action: findings.suggestedAction ?? "cached",
                basis: candidate.node.basis,
                status: candidate.node.status,
                reason: findings.reason ?? "Cached audit result.",
                cached: true,
              });
              continue;
            }
          }

          const verdict = await runtime.verifier.verify(packet);
          if (verdict.verdict === "needs_model") {
            results.push({
              id: candidate.node.id,
              trigger: candidate.trigger,
              riskScore: candidate.riskScore,
              verdict: verdict.verdict,
              action: verdict.suggestedAction,
              basis: candidate.node.basis,
              status: candidate.node.status,
              reason: verdict.reason,
              applied: false,
            });
            continue;
          }
          const applied = applyVerificationVerdict(runtime.store, packet, verdict, {
            author,
            trigger: candidate.trigger,
            sampledBy: "memory_audit",
            riskScore: candidate.riskScore,
            auditor: { tool: "memory_audit", reasons: candidate.reasons },
            cacheSalt,
          });
          results.push({
            id: candidate.node.id,
            trigger: candidate.trigger,
            riskScore: candidate.riskScore,
            verdict: verdict.verdict,
            action: verdict.suggestedAction,
            basis: applied.basis,
            status: applied.status,
            reason: verdict.reason,
            applied: true,
          });
        }

        const lines = [`Audit run: ${results.length} candidate(s)`, ""];
        for (const result of results) {
          const suffix = result.cached
            ? " (cached)"
            : result.applied === false
              ? " (not applied)"
              : "";
          lines.push(
            `- ${String(result.id)}: ${String(result.trigger)} ${String(result.verdict)} → ` +
              `${String(result.basis)}/${String(result.status)}${suffix} — ${String(result.reason)}`,
          );
        }
        return {
          content: lines.join("\n"),
          metadata: { checked: results.length, results },
        };
      },
    });

    editor.namespace({
      name: "memory_admin",
      description: "Precise memory maintenance: cite, link, unlink, update, archive, and audit.",
    });

    editor.add({
      name: "cite",
      description:
        "Add citations to an existing memory node without rewriting its body. File citations must exist. " +
        "This adds evidence; it does not promote the claim's basis or verification state.",
      input: citeSchema,
      options: { namespace: "memory_admin", codemode: true },
      execute: async (raw, context) => {
        const input = raw as unknown as CiteInput;
        await assertWrite(ctx, runtime, context, "memory.cite", [input.id]);
        const node = runtime.store.cite(input.id, input.citations, writeContext(context));
        const detail = runtime.store.get(node.id);
        return {
          content: detail ? formatNode(detail) : `Added citations to ${node.id}.`,
          metadata: { nodeID: node.id, citations: input.citations.length },
        };
      },
    });

    editor.add({
      name: "link",
      description:
        "Add or reactivate a typed edge between two memory nodes. Use part_of, applies_to, depends_on, " +
        "implements, documents, derived_from, related_to, or revises. Supersedes/contradicts use the revision workflow.",
      input: adminLinkSchema,
      options: { namespace: "memory_admin", codemode: true },
      execute: async (raw, context) => {
        const input = raw as unknown as AdminLinkInput;
        await assertWrite(ctx, runtime, context, "memory.link", [input.from, input.to]);
        const edge = runtime.store.link(input.from, input.to, input.type, writeContext(context), input.weight);
        return {
          content: `Linked ${edge.fromID} --${edge.type}--> ${edge.toID}.`,
          metadata: edge,
        };
      },
    });

    editor.add({
      name: "unlink",
      description: "Retire an active typed edge between two memory nodes without deleting history.",
      input: unlinkSchema,
      options: { namespace: "memory_admin", codemode: true },
      execute: async (raw, context) => {
        const input = raw as unknown as UnlinkInput;
        await assertWrite(ctx, runtime, context, "memory.unlink", [input.from, input.to]);
        const removed = runtime.store.unlink(input.from, input.to, input.type, writeContext(context));
        return {
          content: removed
            ? `Unlinked ${input.from} --${input.type}--> ${input.to}.`
            : `No active ${input.type} edge found from ${input.from} to ${input.to}.`,
          metadata: { removed },
        };
      },
    });

    editor.add({
      name: "update",
      description:
        "Update a memory node's display title, scope, or tags without rewriting its body. The node ID and " +
        "canonical deduplication key remain stable; use memory_remember for semantic revisions.",
      input: updateSchema,
      options: { namespace: "memory_admin", codemode: true },
      execute: async (raw, context) => {
        const input = raw as unknown as UpdateInput;
        await assertWrite(ctx, runtime, context, "memory.update", [input.id]);
        const node = runtime.store.update(
          input.id,
          { title: input.title, scope: input.scope, tags: input.tags, reason: input.reason },
          writeContext(context),
        );
        const detail = runtime.store.get(node.id);
        return {
          content: detail ? formatNode(detail) : `Updated ${node.id}.`,
          metadata: { nodeID: node.id, title: node.title },
        };
      },
    });

    editor.add({
      name: "archive",
      description:
        "Soft-delete a memory node. The node, citations, edges, versions, and audit history remain available " +
        "through memory_get; default recall excludes archived nodes.",
      input: archiveSchema,
      options: { namespace: "memory_admin", codemode: true },
      execute: async (raw, context) => {
        const input = raw as unknown as ArchiveInput;
        await assertWrite(ctx, runtime, context, "memory.archive", [input.id], true);
        const node = runtime.store.archive(input.id, writeContext(context), input.reason);
        const detail = runtime.store.get(node.id);
        return {
          content: detail ? formatNode(detail) : `Archived ${node.id}.`,
          metadata: { nodeID: node.id, status: node.status },
        };
      },
    });
  });
}

function writeContext(context: ToolContext) {
  return {
    author: {
      type: "agent" as const,
      id: String(context.agent),
      sessionID: String(context.sessionID),
    },
    agent: String(context.agent),
    sessionID: String(context.sessionID),
    messageID: String(context.messageID),
  };
}

async function assertWrite(
  ctx: PluginContext,
  runtime: Runtime,
  context: ToolContext,
  action: string,
  resources: string[],
  force = false,
): Promise<void> {
  if (!force && !runtime.requireWritePermission) return;
  await ctx.permission.assert({
    sessionID: context.sessionID,
    agent: context.agent,
    action,
    resources,
    source: { type: "tool", messageID: context.messageID, id: context.id },
  });
}
