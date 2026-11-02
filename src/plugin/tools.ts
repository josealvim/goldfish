import type { Registration } from "@opencode/plugin/promise/registration";
import { formatNeighbors, formatNode, formatRecall, formatRemember } from "../core/format.ts";
import { EDGE_TYPES, NODE_KINDS, SOURCE_TYPES } from "../core/types.ts";
import type {
  EdgeType,
  MemoryProposal,
  NeighborOptions,
  NodeKind,
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
      items: {
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
      },
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
      enum: ["verified", "cited", "inferred"],
      description:
        "verified requires human/test/commit evidence; cited requires a valid source; inferred is unverified.",
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
            nodeID: result.node?.id,
            autoInjectEligible: result.node?.autoInjectEligible,
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
  });
}
