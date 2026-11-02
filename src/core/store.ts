import { readFileSync } from "node:fs";
import path from "node:path";
import {
  type AuditCandidate,
  type AuditInfo,
  type AuditRecordInput,
  type ApplyVerificationInput,
  type Author,
  type Basis,
  type Citation,
  type CitationCheck,
  type CitationInput,
  type ConflictProposal,
  type ConflictProposalInput,
  type ConflictStatus,
  type Edge,
  type EdgeType,
  type ExportBundle,
  type HealthIssue,
  type InjectionInfo,
  type LinkInput,
  type MemoryCard,
  type MemoryDetail,
  type MemoryHealth,
  type MemoryListItem,
  type MemoryListQuery,
  type MemoryListResult,
  type MemoryNode,
  type MemoryProposal,
  type MemoryStats,
  type MemoryStatus,
  type Neighbor,
  type NeighborOptions,
  type NeighborResult,
  type NodeKind,
  type NodeStatus,
  type NodeVersion,
  type OnboardingState,
  type RecallQuery,
  type RecallResult,
  type RememberResult,
  type ReviewItem,
  type SourceType,
  type VerificationState,
  type WriteContext,
  isClaimKind,
} from "./types.ts";
import {
  baseNodeId,
  canonicalKey,
  isMaterialChange,
  normalizeBody,
  normalizeText,
  sha256,
  shortHash,
  slug,
  strongerBasis,
  uniqueStrings,
} from "./ids.ts";
import { anyScopeMatches, scopeMatchScore } from "./glob.ts";
import { DEFAULT_POLICY, effectiveAllowedBasis, isAutoInjectEligible, type InjectionPolicy } from "./policy.ts";
import { initSchema } from "./schema.ts";
import { transaction, type SqliteDatabase, type SqlValue } from "./sqlite.ts";
import { estimateTokens, formatCardText } from "./format.ts";
import { buildCitationSnapshot, type SourceSnapshotOptions } from "./sources.ts";
import { containsInstructionLikeText, containsSecret } from "./safety.ts";

type Row = Record<string, unknown>;

export interface MemoryStoreOptions {
  db: SqliteDatabase;
  projectRoot: string;
  policy?: InjectionPolicy;
  now?: () => Date;
  maxBodyCharacters?: number;
}

export interface OpenMemoryStoreOptions {
  dbPath: string;
  projectRoot: string;
  policy?: InjectionPolicy;
  now?: () => Date;
  maxBodyCharacters?: number;
}

interface ResolvedCitation {
  input: CitationInput;
  sourceID: string;
  contentHash?: string;
  validation: "ok" | "missing" | "unchecked";
  metadata: Record<string, unknown>;
}

const DEFAULT_MAX_BODY_CHARACTERS = 6000;

export class MemoryStore {
  readonly projectRoot: string;
  readonly policy: InjectionPolicy;
  private readonly db: SqliteDatabase;
  private readonly nowFn: () => Date;
  private readonly maxBodyCharacters: number;

  constructor(options: MemoryStoreOptions) {
    this.db = options.db;
    this.projectRoot = path.resolve(options.projectRoot);
    this.policy = options.policy ?? DEFAULT_POLICY;
    this.nowFn = options.now ?? (() => new Date());
    this.maxBodyCharacters = options.maxBodyCharacters ?? DEFAULT_MAX_BODY_CHARACTERS;
  }

  static async open(options: OpenMemoryStoreOptions): Promise<MemoryStore> {
    const { openSqlite } = await import("./sqlite.ts");
    const db = await openSqlite(options.dbPath);
    const store = new MemoryStore({
      db,
      projectRoot: options.projectRoot,
      policy: options.policy,
      now: options.now,
      maxBodyCharacters: options.maxBodyCharacters,
    });
    store.init();
    return store;
  }

  init(): void {
    initSchema(this.db);
  }

  close(): void {
    this.db.close();
  }

  private now(): string {
    return this.nowFn().toISOString();
  }

  private getRow(id: string): Row | undefined {
    return this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id);
  }

  private getRowByCanonical(canonical: string): Row | undefined {
    return this.db.prepare("SELECT * FROM nodes WHERE canonical_key = ?").get(canonical);
  }

  private getCitations(nodeID: string, version: number): Citation[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, s.type AS source_type, s.locator AS source_locator,
                s.content_hash AS source_content_hash
         FROM citations c
         JOIN sources s ON s.id = c.source_id
         WHERE c.node_id = ? AND c.node_version = ?
         ORDER BY c.id`,
      )
      .all(nodeID, version);
    return rows.map((row) => this.rowToCitation(row));
  }

  private rowToCitation(row: Row): Citation {
    const metadata = parseJson<Record<string, unknown>>(row.locator_json, {});
    const validation = metadata.validation;
    return {
      type: String(row.source_type) as SourceType,
      locator: String(row.source_locator),
      excerpt: optionalString(row.excerpt),
      metadata,
      sourceID: String(row.source_id),
      contentHash: optionalString(row.source_content_hash),
      excerptHash: optionalString(row.excerpt_hash),
      observedAt: String(row.observed_at),
      validation:
        validation === "ok" || validation === "missing" || validation === "unchecked" ? validation : "unchecked",
    };
  }

  private rowToNode(row: Row): MemoryNode {
    return {
      id: String(row.id),
      kind: String(row.kind) as NodeKind,
      title: String(row.title),
      body: String(row.body),
      scope: parseJson<string[]>(row.scope_json, []),
      tags: parseJson<string[]>(row.tags_json, []),
      status: String(row.status) as NodeStatus,
      basis: String(row.basis) as Basis,
      confidence: Number(row.confidence ?? 0.5),
      verificationState: String(row.verification_state) as VerificationState,
      canonicalKey: String(row.canonical_key),
      version: Number(row.current_version ?? 1),
      author: parseJson<Author>(row.author_json, { type: "system", id: "unknown" }),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastConfirmedAt: optionalString(row.last_confirmed_at),
      validFrom: optionalString(row.valid_from),
      validTo: optionalString(row.valid_to),
      materialRevisionAt: optionalString(row.material_revision_at),
      autoInjectEligible: Number(row.auto_inject_eligible) === 1,
      metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    };
  }

  private rowToVersion(row: Row): NodeVersion {
    return {
      nodeID: String(row.node_id),
      version: Number(row.version),
      title: String(row.title),
      body: String(row.body),
      basis: String(row.basis) as Basis,
      confidence: Number(row.confidence),
      status: String(row.status) as NodeStatus,
      verificationState: String(row.verification_state) as VerificationState,
      author: parseJson<Author>(row.author_json, { type: "system", id: "unknown" }),
      reason: optionalString(row.reason),
      evidence: parseJson<unknown[]>(row.evidence_json, []),
      createdAt: String(row.created_at),
    };
  }

  private rowToEdge(row: Row): Edge {
    return {
      fromID: String(row.from_id),
      toID: String(row.to_id),
      type: String(row.type) as EdgeType,
      weight: Number(row.weight ?? 1),
      metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
      createdAt: String(row.created_at),
      retiredAt: optionalString(row.retired_at),
    };
  }

  private rowToAudit(row: Row): AuditInfo {
    return {
      id: Number(row.id),
      version: Number(row.node_version),
      trigger: String(row.trigger),
      sampledBy: String(row.sampled_by),
      riskScore: Number(row.risk_score ?? 0),
      auditor: parseJson<Record<string, unknown>>(row.auditor_json, {}),
      outcome: String(row.outcome),
      findings: parseJson<Record<string, unknown>>(row.findings_json, {}),
      createdAt: String(row.created_at),
    };
  }

  private rowToInjection(row: Row): InjectionInfo {
    return {
      id: Number(row.id),
      sessionID: String(row.session_id),
      messageID: optionalString(row.message_id),
      rank: Number(row.rank),
      tokens: Number(row.tokens),
      source: String(row.source),
      createdAt: String(row.created_at),
    };
  }

  private getAudits(nodeID: string): AuditInfo[] {
    return this.db
      .prepare("SELECT * FROM audits WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 20")
      .all(nodeID)
      .map((row) => this.rowToAudit(row));
  }

  private getInjections(nodeID: string): InjectionInfo[] {
    return this.db
      .prepare("SELECT * FROM injections WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 20")
      .all(nodeID)
      .map((row) => this.rowToInjection(row));
  }

  private getEdges(nodeID: string): Edge[] {
    return this.db
      .prepare(
        `SELECT * FROM edges
         WHERE (from_id = ? OR to_id = ?) AND retired_at IS NULL
         ORDER BY id`,
      )
      .all(nodeID, nodeID)
      .map((row) => this.rowToEdge(row));
  }

  private recordEvent(author: Author, action: string, nodeID: string | undefined, payload: Record<string, unknown>): void {
    this.db
      .prepare("INSERT INTO events(ts, actor_json, action, node_id, payload_json) VALUES(?, ?, ?, ?, ?)")
      .run(this.now(), JSON.stringify(author), action, nodeID ?? null, JSON.stringify(payload));
  }

  private insertVersion(node: MemoryNode, reason: string, evidence: unknown[] = []): void {
    this.db
      .prepare(
        `INSERT INTO node_versions
          (node_id, version, title, body, basis, confidence, status, verification_state,
           author_json, reason, evidence_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        node.id,
        node.version,
        node.title,
        node.body,
        node.basis,
        node.confidence,
        node.status,
        node.verificationState,
        JSON.stringify(node.author),
        reason,
        JSON.stringify(evidence),
        this.now(),
      );
  }

  private indexFts(node: MemoryNode): void {
    this.db.prepare("DELETE FROM nodes_fts WHERE node_id = ?").run(node.id);
    this.db
      .prepare("INSERT INTO nodes_fts(node_id, title, body, tags) VALUES(?, ?, ?, ?)")
      .run(node.id, node.title, node.body, node.tags.join(" "));
  }

  private upsertSource(resolved: ResolvedCitation, now: string): string {
    const sourceID = resolved.sourceID;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO sources(id, type, locator, content_hash, observed_at, metadata_json)
         VALUES(?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sourceID,
        resolved.input.type,
        resolved.input.locator,
        resolved.contentHash ?? null,
        now,
        JSON.stringify(resolved.metadata),
      );
    this.db
      .prepare(
        `UPDATE sources
         SET content_hash = ?, observed_at = ?, metadata_json = ?
         WHERE type = ? AND locator = ?`,
      )
      .run(
        resolved.contentHash ?? null,
        now,
        JSON.stringify(resolved.metadata),
        resolved.input.type,
        resolved.input.locator,
      );
    const row = this.db
      .prepare("SELECT id FROM sources WHERE type = ? AND locator = ?")
      .get(resolved.input.type, resolved.input.locator);
    return row ? String(row.id) : sourceID;
  }

  private insertCitations(nodeID: string, version: number, citations: ResolvedCitation[]): void {
    const now = this.now();
    for (const citation of citations) {
      const sourceID = this.upsertSource(citation, now);
      const locatorJSON = JSON.stringify(citation.metadata);
      const existing = this.db
        .prepare(
          `SELECT 1 FROM citations
           WHERE node_id = ? AND node_version = ? AND source_id = ? AND locator_json = ?`,
        )
        .get(nodeID, version, sourceID, locatorJSON);
      if (existing) continue;
      this.db
        .prepare(
          `INSERT INTO citations
            (node_id, node_version, source_id, locator_json, excerpt, excerpt_hash, observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          nodeID,
          version,
          sourceID,
          locatorJSON,
          citation.input.excerpt ?? null,
          citation.input.excerpt ? sha256(citation.input.excerpt) : null,
          now,
        );
    }
  }

  private copyCitations(nodeID: string, fromVersion: number, toVersion: number): void {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO citations
          (node_id, node_version, source_id, locator_json, excerpt, excerpt_hash, observed_at)
         SELECT node_id, ?, source_id, locator_json, excerpt, excerpt_hash, ?
         FROM citations
         WHERE node_id = ? AND node_version = ?`,
      )
      .run(toVersion, now, nodeID, fromVersion);
  }

  private resolveCitations(citations: CitationInput[]): ResolvedCitation[] {
    return citations.map((input) => {
      const sourceID = `src_${shortHash(`${input.type}:${input.locator}`)}`;
      if (input.type === "file") {
        const absolute = path.isAbsolute(input.locator)
          ? input.locator
          : path.resolve(this.projectRoot, input.locator);
        try {
          const content = readFileSync(absolute);
          return {
            input,
            sourceID,
            contentHash: sha256(content),
            validation: "ok",
            metadata: { ...(input.metadata ?? {}), validation: "ok" },
          };
        } catch {
          return {
            input,
            sourceID,
            contentHash: undefined,
            validation: "missing",
            metadata: { ...(input.metadata ?? {}), validation: "missing" },
          };
        }
      }
      return {
        input,
        sourceID,
        contentHash: undefined,
        validation: "unchecked",
        metadata: { ...(input.metadata ?? {}), validation: "unchecked" },
      };
    });
  }

  private effectiveBasis(
    proposal: MemoryProposal,
    citations: ResolvedCitation[],
    author: Author,
    hasDerivedPremises = false,
  ): Basis {
    const requested =
      proposal.basis ?? (citations.length ? "cited" : hasDerivedPremises ? "derived" : "inferred");
    if (requested === "inferred") return "inferred";
    if (requested === "derived") {
      if (citations.some((citation) => citation.validation === "missing")) return "inferred";
      if (!citations.length && !hasDerivedPremises) return "inferred";
      return "derived";
    }
    if (!citations.length) return "inferred";
    if (citations.some((citation) => citation.validation === "missing")) return "inferred";
    if (requested === "verified") {
      const hasVerificationEvidence = citations.some(
        (citation) =>
          citation.input.type === "test" ||
          citation.input.type === "commit" ||
          citation.input.type === "human",
      );
      return author.type === "human" || hasVerificationEvidence ? "verified" : "cited";
    }
    return "cited";
  }

  private defaultConfidence(basis: Basis): number {
    if (basis === "verified") return 0.9;
    if (basis === "cited") return 0.7;
    if (basis === "derived") return 0.6;
    return 0.4;
  }

  private allocateNodeID(kind: NodeKind, title: string, canonical: string): string {
    const base = baseNodeId(kind, title);
    const existing = this.getRow(base);
    if (!existing || String(existing.canonical_key) === canonical) return base;
    return `${base}-${shortHash(canonical)}`;
  }

  private allocateForkID(kind: NodeKind, title: string, forkKey: string): string {
    const base = `${baseNodeId(kind, title)}-alt-${forkKey}`;
    let candidate = base;
    let counter = 2;
    while (this.getRow(candidate)) {
      candidate = `${base}-${counter++}`;
    }
    return candidate;
  }

  private linkTargets(
    nodeID: string,
    links: LinkInput[] | undefined,
    author: Author,
    warnings: string[],
  ): void {
    for (const link of links ?? []) {
      if (link.to === nodeID) {
        warnings.push(`Ignoring self-link ${link.type}.`);
        continue;
      }
      if (!this.getRow(link.to)) {
        warnings.push(`Link target ${link.to} does not exist; skipped.`);
        continue;
      }
      this.db
        .prepare(
          `INSERT INTO edges(from_id, to_id, type, weight, metadata_json, created_at)
           VALUES(?, ?, ?, ?, ?, ?)
           ON CONFLICT(from_id, to_id, type) DO UPDATE SET retired_at = NULL`,
        )
        .run(
          nodeID,
          link.to,
          link.type,
          link.weight ?? 1,
          JSON.stringify(link.metadata ?? {}),
          this.now(),
        );
      this.recordEvent(author, "link", nodeID, { to: link.to, type: link.type });
    }
  }

  private markSuperseded(targetID: string, byID: string, author: Author): void {
    this.db
      .prepare(
        `UPDATE nodes SET status = 'superseded', auto_inject_eligible = 0, updated_at = ?
         WHERE id = ?`,
      )
      .run(this.now(), targetID);
    this.db
      .prepare(
        `INSERT INTO edges(from_id, to_id, type, weight, metadata_json, created_at)
         VALUES(?, ?, 'supersedes', 1, '{}', ?)
         ON CONFLICT(from_id, to_id, type) DO UPDATE SET retired_at = NULL`,
      )
      .run(byID, targetID, this.now());
    this.recordEvent(author, "supersede", byID, { target: targetID });
  }

  private markTargetDisputed(targetID: string, byID: string, author: Author): void {
    this.db
      .prepare(
        `UPDATE nodes SET status = 'disputed', auto_inject_eligible = 0, updated_at = ?
         WHERE id = ?`,
      )
      .run(this.now(), targetID);
    this.db
      .prepare(
        `INSERT INTO edges(from_id, to_id, type, weight, metadata_json, created_at)
         VALUES(?, ?, 'contradicts', 1, '{}', ?)
         ON CONFLICT(from_id, to_id, type) DO UPDATE SET retired_at = NULL`,
      )
      .run(byID, targetID, this.now());
    this.recordEvent(author, "dispute", byID, { target: targetID });
  }

  private writeNodeRow(node: MemoryNode): void {
    this.db
      .prepare(
        `INSERT INTO nodes
          (id, kind, title, body, scope_json, tags_json, status, basis, confidence, verification_state,
           canonical_key, current_version, author_json, created_at, updated_at, last_confirmed_at,
           valid_from, valid_to, material_revision_at, auto_inject_eligible, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        node.id,
        node.kind,
        node.title,
        node.body,
        JSON.stringify(node.scope),
        JSON.stringify(node.tags),
        node.status,
        node.basis,
        node.confidence,
        node.verificationState,
        node.canonicalKey,
        node.version,
        JSON.stringify(node.author),
        node.createdAt,
        node.updatedAt,
        node.lastConfirmedAt ?? null,
        node.validFrom ?? null,
        node.validTo ?? null,
        node.materialRevisionAt ?? null,
        node.autoInjectEligible ? 1 : 0,
        JSON.stringify(node.metadata),
      );
    this.indexFts(node);
  }

  private updateNodeRow(node: MemoryNode): void {
    this.db
      .prepare(
        `UPDATE nodes SET
           kind = ?, title = ?, body = ?, scope_json = ?, tags_json = ?, status = ?, basis = ?,
           confidence = ?, verification_state = ?, canonical_key = ?, current_version = ?,
           author_json = ?, updated_at = ?, last_confirmed_at = ?, valid_from = ?, valid_to = ?,
           material_revision_at = ?, auto_inject_eligible = ?, metadata_json = ?
         WHERE id = ?`,
      )
      .run(
        node.kind,
        node.title,
        node.body,
        JSON.stringify(node.scope),
        JSON.stringify(node.tags),
        node.status,
        node.basis,
        node.confidence,
        node.verificationState,
        node.canonicalKey,
        node.version,
        JSON.stringify(node.author),
        node.updatedAt,
        node.lastConfirmedAt ?? null,
        node.validFrom ?? null,
        node.validTo ?? null,
        node.materialRevisionAt ?? null,
        node.autoInjectEligible ? 1 : 0,
        JSON.stringify(node.metadata),
        node.id,
      );
    this.indexFts(node);
  }

  private recomputeEligibility(node: MemoryNode, currentScope: string[] = []): MemoryNode {
    return {
      ...node,
      autoInjectEligible: isAutoInjectEligible(node, currentScope.length ? currentScope : node.scope, this.policy),
    };
  }

  remember(proposal: MemoryProposal, context: WriteContext): RememberResult {
    return transaction(this.db, () => this.rememberInTransaction(proposal, context));
  }

  private rememberInTransaction(proposal: MemoryProposal, context: WriteContext): RememberResult {
    const title = normalizeText(proposal.title ?? "");
    const body = normalizeBody(proposal.body ?? "");
    const reasons: string[] = [];

    if (!title || !body) {
      return { action: "rejected", reasons: ["title and body are required"] };
    }
    if (body.length > this.maxBodyCharacters) {
      return {
        action: "rejected",
        reasons: [`body exceeds ${this.maxBodyCharacters} characters; store a claim and source, not a code dump`],
      };
    }
    if (containsSecret(`${title}\n${body}`)) {
      return { action: "rejected", reasons: ["possible secret detected; memory must not store credentials"] };
    }
    if (containsInstructionLikeText(body)) {
      return { action: "rejected", reasons: ["possible prompt-injection text detected; memory is data, not instructions"] };
    }

    const now = context.now ?? this.now();
    const author = context.author;
    const citations = this.resolveCitations(proposal.citations ?? []);
    const hasDerivedPremises = (proposal.links ?? []).some(
      (link) => link.type === "derived_from" && Boolean(this.getRow(link.to)),
    );
    const basis = this.effectiveBasis(proposal, citations, author, hasDerivedPremises);
    const scope = uniqueStrings(proposal.scope);
    const tags = uniqueStrings(proposal.tags);
    const confidence = clamp(proposal.confidence ?? this.defaultConfidence(basis), 0, 1);
    const baseCanonical = canonicalKey(proposal.kind, title);

    const contradictionTargets = (proposal.contradicts ?? [])
      .map((id) => this.getRow(id))
      .filter((row): row is Row => Boolean(row));
    const supersedesTarget = proposal.supersedes ? this.getRow(proposal.supersedes) : undefined;
    const isFork = contradictionTargets.length > 0;
    const forkKey = shortHash(
      `${body}\n${contradictionTargets.map((target) => String(target.id)).sort().join(",")}`,
    );
    const lookupCanonical = isFork ? `${baseCanonical}#alt:${forkKey}` : baseCanonical;
    const existingRow = this.getRowByCanonical(lookupCanonical);
    const existing = existingRow ? this.rowToNode(existingRow) : undefined;

    if (proposal.supersedes && !supersedesTarget) {
      reasons.push(`Supersedes target ${proposal.supersedes} does not exist; ignored.`);
    }
    if (proposal.contradicts?.length && !contradictionTargets.length) {
      reasons.push("No existing contradiction target was found; the claim was stored without a conflict edge.");
    }

    if (existing) {
      const material = isMaterialChange(
        { title: existing.title, body: existing.body, scope: existing.scope, citations: [] },
        { title, body, scope, citations: [] },
      );

      if (!material) {
        this.insertCitations(existing.id, existing.version, citations);
        const merged = this.recomputeEligibility(
          {
            ...existing,
            scope: uniqueStrings([...existing.scope, ...scope]),
            tags: uniqueStrings([...existing.tags, ...tags]),
            basis: strongerBasis(existing.basis, basis),
            confidence: Math.max(existing.confidence, confidence),
            verificationState:
              basis === "derived"
                ? "unverified"
                : existing.basis === "inferred" && basis !== "inferred"
                  ? "not_required"
                  : existing.verificationState,
            lastConfirmedAt:
              basis === "verified" || basis === "cited" ? now : existing.lastConfirmedAt,
            updatedAt: now,
            metadata: { ...existing.metadata, ...(proposal.metadata ?? {}) },
          },
          scope,
        );
        this.updateNodeRow(merged);
        this.linkTargets(merged.id, proposal.links, author, reasons);
        if (supersedesTarget && String(supersedesTarget.id) !== merged.id) {
          this.markSuperseded(String(supersedesTarget.id), merged.id, author);
        }
        for (const target of contradictionTargets) {
          if (String(target.id) !== merged.id) this.markTargetDisputed(String(target.id), merged.id, author);
        }
        this.recordEvent(author, "merge", merged.id, {
          citations: citations.length,
          basis: merged.basis,
          version: merged.version,
        });
        return { action: "merged", node: merged, reasons: reasons.length ? reasons : undefined };
      }

      const nextVersion = existing.version + 1;
      const nextStatus: NodeStatus =
        isFork || (existing.status === "disputed" && proposal.metadata?.resolveDispute !== true)
          ? "disputed"
          : "active";
      const nextVerification: VerificationState =
        basis === "inferred" || basis === "derived" ? "unverified" : "not_required";
      const revised = this.recomputeEligibility(
        {
          ...existing,
          title,
          body,
          scope: uniqueStrings([...existing.scope, ...scope]),
          tags: uniqueStrings([...existing.tags, ...tags]),
          basis,
          confidence,
          verificationState: nextVerification,
          status: nextStatus,
          version: nextVersion,
          author,
          updatedAt: now,
          lastConfirmedAt: basis === "verified" || basis === "cited" ? now : existing.lastConfirmedAt,
          materialRevisionAt: now,
          metadata: { ...existing.metadata, ...(proposal.metadata ?? {}) },
        },
        scope,
      );
      this.updateNodeRow(revised);
      this.insertVersion(revised, "revision", proposal.citations ?? []);
      this.insertCitations(revised.id, revised.version, citations);
      this.linkTargets(revised.id, proposal.links, author, reasons);
      if (supersedesTarget && String(supersedesTarget.id) !== revised.id) {
        this.markSuperseded(String(supersedesTarget.id), revised.id, author);
      }
      for (const target of contradictionTargets) {
        if (String(target.id) !== revised.id) this.markTargetDisputed(String(target.id), revised.id, author);
      }
      this.recordEvent(author, "revise", revised.id, {
        fromVersion: existing.version,
        toVersion: revised.version,
        basis: revised.basis,
      });
      return { action: "revised", node: revised, reasons: reasons.length ? reasons : undefined };
    }

    const nodeID = isFork
      ? this.allocateForkID(proposal.kind, title, forkKey)
      : this.allocateNodeID(proposal.kind, title, baseCanonical);
    const canonical = isFork ? `${baseCanonical}#alt:${forkKey}` : baseCanonical;
    const verificationState: VerificationState =
      basis === "inferred" || basis === "derived" ? "unverified" : "not_required";
    const status: NodeStatus = contradictionTargets.length ? "disputed" : "active";
    const node: MemoryNode = this.recomputeEligibility(
      {
        id: nodeID,
        kind: proposal.kind,
        title,
        body,
        scope,
        tags,
        status,
        basis,
        confidence,
        verificationState,
        canonicalKey: canonical,
        version: 1,
        author,
        createdAt: now,
        updatedAt: now,
        lastConfirmedAt: basis === "verified" || basis === "cited" ? now : undefined,
        materialRevisionAt: now,
        autoInjectEligible: false,
        metadata: { ...(proposal.metadata ?? {}) },
      },
      scope,
    );

    this.writeNodeRow(node);
    this.insertVersion(node, "created", proposal.citations ?? []);
    this.insertCitations(node.id, node.version, citations);
    this.linkTargets(node.id, proposal.links, author, reasons);

    if (supersedesTarget && String(supersedesTarget.id) !== node.id) {
      this.markSuperseded(String(supersedesTarget.id), node.id, author);
    }
    for (const target of contradictionTargets) {
      if (String(target.id) !== node.id) this.markTargetDisputed(String(target.id), node.id, author);
    }

    this.recordEvent(author, "create", node.id, {
      kind: node.kind,
      basis: node.basis,
      scope: node.scope,
      citations: citations.length,
      conflict: contradictionTargets.length > 0,
    });

    return {
      action: contradictionTargets.length ? "conflict" : "created",
      node,
      conflicts: contradictionTargets.map((target) => String(target.id)),
      reasons: reasons.length ? reasons : undefined,
    };
  }

  recall(query: RecallQuery): RecallResult {
    const limit = clamp(Math.floor(query.limit ?? 8), 1, 50);
    const budgetTokens = clamp(Math.floor(query.budgetTokens ?? 1200), 100, 8000);
    const candidateLimit = Math.max(limit * 12, 60);
    const ftsQuery = buildFtsQuery(query.query);
    const rows = ftsQuery
      ? this.db
          .prepare(
            `SELECT n.*, bm25(nodes_fts) AS bm25
             FROM nodes_fts
             JOIN nodes n ON n.id = nodes_fts.node_id
             WHERE nodes_fts MATCH ?
             ORDER BY bm25
             LIMIT ?`,
          )
          .all(ftsQuery, candidateLimit)
      : this.db
          .prepare("SELECT n.*, 0 AS bm25 FROM nodes n ORDER BY n.updated_at DESC LIMIT ?")
          .all(candidateLimit);

    const queryTokens = queryTokensFor(query.query);
    const queryScope = query.scope ?? [];
    const statuses = new Set<NodeStatus>(
      query.statuses ?? [
        "active",
        ...(query.includeDisputed ? (["disputed"] as NodeStatus[]) : []),
        ...(query.includeStale ? (["stale"] as NodeStatus[]) : []),
        ...(query.includeArchived ? (["archived", "superseded"] as NodeStatus[]) : []),
      ],
    );

    const ranked = new Map<string, { node: MemoryNode; score: number; reasons: string[] }>();
    rows.forEach((row, index) => {
      const node = this.rowToNode(row);
      if (!this.passesRecallFilters(node, query, statuses)) return;
      const scored = this.scoreNode(node, queryTokens, queryScope, 1 / (10 + index + 1), ["lexical"]);
      ranked.set(node.id, scored);
    });

    // One-hop graph expansion from the strongest lexical candidates. This is
    // where relationships add context that a pure text index would miss. Graph
    // neighbors are deliberately ranked below their seed: they carry related
    // context, not independent lexical evidence.
    const relationalQuery =
      /\b(related|relationship|depend|depends|impact|affect|uses|used by|part of|conflict|contradict|supersede|why|decision)\b/i.test(
        query.query,
      );
    const graphEdgeTypes = new Set([
      "applies_to",
      "depends_on",
      "contradicts",
      "supersedes",
      "documents",
      "derived_from",
      "related_to",
      "part_of",
    ]);
    const seeds = [...ranked.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, 2);
    for (const seed of seeds) {
      const edges = this.getEdges(seed.node.id).slice(0, 8);
      for (const edge of edges) {
        if (!graphEdgeTypes.has(edge.type)) continue;
        const neighborID = edge.fromID === seed.node.id ? edge.toID : edge.fromID;
        if (ranked.has(neighborID)) continue;
        const row = this.getRow(neighborID);
        if (!row) continue;
        const node = this.rowToNode(row);
        if (!this.passesRecallFilters(node, query, statuses)) continue;
        const overlap = hasTokenOverlap(node, queryTokens);
        const conflict = edge.type === "contradicts" || edge.type === "supersedes";
        if (!overlap && !relationalQuery && !conflict) continue;
        const score = seed.score * 0.3 + (overlap ? 0.04 : 0) + (conflict ? 0.02 : 0);
        ranked.set(node.id, {
          node,
          score: Math.min(score, seed.score - 0.01),
          reasons: ["graph", `via ${edge.type}`],
        });
      }
    }

    const sorted = [...ranked.values()].sort((left, right) => right.score - left.score);
    const cards: MemoryCard[] = [];
    let tokens = 0;

    for (const entry of sorted) {
      if (cards.length >= limit) break;
      const citations = this.getCitations(entry.node.id, entry.node.version);
      const related = this.getEdges(entry.node.id)
        .slice(0, 4)
        .map((edge) => ({
          id: edge.fromID === entry.node.id ? edge.toID : edge.fromID,
          type: edge.type,
        }));
      const card: MemoryCard = {
        id: entry.node.id,
        kind: entry.node.kind,
        title: entry.node.title,
        body: truncate(entry.node.body, 700),
        scope: entry.node.scope,
        tags: entry.node.tags,
        status: entry.node.status,
        basis: entry.node.basis,
        confidence: entry.node.confidence,
        verificationState: entry.node.verificationState,
        citations,
        related,
        score: entry.score,
        reasons: entry.reasons,
      };
      let text = formatCardText(card);
      let cardTokens = estimateTokens(text);
      if (tokens + cardTokens > budgetTokens) {
        if (!cards.length) {
          card.body = truncate(card.body, Math.max(120, Math.floor(card.body.length * 0.5)));
          text = formatCardText(card);
          cardTokens = estimateTokens(text);
        }
        if (tokens + cardTokens > budgetTokens) break;
      }
      cards.push(card);
      tokens += cardTokens;
    }

    return {
      query: query.query,
      cards,
      candidates: sorted.length,
      tokens,
      hasMore: sorted.length > cards.length,
    };
  }

  relatedClaims(id: string, options: { limit?: number } = {}): MemoryNode[] {
    const row = this.getRow(id);
    if (!row) return [];
    const target = this.rowToNode(row);
    const limit = clamp(Math.floor(options.limit ?? 3), 1, 10);
    const candidateLimit = Math.max(limit * 20, 80);
    const ftsQuery = buildFtsQuery(`${target.title} ${target.body} ${target.tags.join(" ")}`);
    const rows = ftsQuery
      ? this.db
          .prepare(
            `SELECT n.*, bm25(nodes_fts) AS bm25
             FROM nodes_fts
             JOIN nodes n ON n.id = nodes_fts.node_id
             WHERE nodes_fts MATCH ? AND n.status = 'active'
             ORDER BY bm25
             LIMIT ?`,
          )
          .all(ftsQuery, candidateLimit)
      : this.db
          .prepare(
            "SELECT * FROM nodes WHERE status = 'active' ORDER BY updated_at DESC LIMIT ?",
          )
          .all(candidateLimit);

    const existingConflicts = new Set(
      this.getEdges(target.id)
        .filter((edge) => edge.type === "contradicts")
        .map((edge) => (edge.fromID === target.id ? edge.toID : edge.fromID)),
    );
    const ranked = new Map<string, { node: MemoryNode; score: number; reasons: string[] }>();
    const consider = (node: MemoryNode, score: number, reason: string) => {
      if (node.id === target.id || node.status !== "active" || !isClaimKind(node.kind)) return;
      if (existingConflicts.has(node.id)) return;
      if (target.scope.length && node.scope.length) {
        const overlaps =
          anyScopeMatches(target.scope, node.scope) ||
          anyScopeMatches(node.scope, target.scope);
        if (!overlaps) return;
      }
      const previous = ranked.get(node.id);
      if (previous && previous.score >= score) {
        previous.reasons.push(reason);
        return;
      }
      ranked.set(node.id, {
        node,
        score,
        reasons: previous ? [...previous.reasons, reason] : [reason],
      });
    };

    const targetTags = new Set(target.tags);
    rows.forEach((candidateRow, index) => {
      const node = this.rowToNode(candidateRow);
      const tagOverlap = node.tags.filter((tag) => targetTags.has(tag)).length;
      const score =
        1 / (10 + index + 1) +
        Math.min(0.2, tagOverlap * 0.05) +
        (node.kind === target.kind ? 0.03 : 0);
      consider(node, score, "lexical");
    });

    for (const edge of this.getEdges(target.id).slice(0, 20)) {
      if (edge.type === "contradicts") continue;
      const neighborID = edge.fromID === target.id ? edge.toID : edge.fromID;
      const neighborRow = this.getRow(neighborID);
      if (!neighborRow) continue;
      const node = this.rowToNode(neighborRow);
      const tagOverlap = node.tags.filter((tag) => targetTags.has(tag)).length;
      consider(node, 0.35 + Math.min(0.1, tagOverlap * 0.03), `via ${edge.type}`);
    }

    return [...ranked.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((entry) => entry.node);
  }

  conflictTargets(options: { scope?: string; limit?: number } = {}): MemoryNode[] {
    const limit = clamp(Math.floor(options.limit ?? 3), 1, 10);
    return this.db
      .prepare(
        `SELECT n.*,
                (SELECT COUNT(*) FROM injections i WHERE i.node_id = n.id) AS injection_count
         FROM nodes n
         WHERE n.status = 'active' AND n.auto_inject_eligible = 1
         ORDER BY n.confidence ASC, injection_count DESC, n.updated_at DESC
         LIMIT 500`,
      )
      .all()
      .map((row) => this.rowToNode(row))
      .filter((node) => isClaimKind(node.kind))
      .filter(
        (node) =>
          !options.scope ||
          !node.scope.length ||
          anyScopeMatches(node.scope, [options.scope]),
      )
      .slice(0, limit);
  }

  private passesRecallFilters(node: MemoryNode, query: RecallQuery, statuses: Set<NodeStatus>): boolean {
    if (!statuses.has(node.status)) return false;
    if (query.kinds?.length && !query.kinds.includes(node.kind)) return false;
    if (query.includeInferred === false && node.basis === "inferred") return false;
    if (query.autoInjectOnly && !isAutoInjectEligible(node, query.scope ?? [], this.policy)) return false;
    return true;
  }

  private scoreNode(
    node: MemoryNode,
    queryTokens: string[],
    queryScope: string[],
    lexical: number,
    reasons: string[],
  ): { node: MemoryNode; score: number; reasons: string[] } {
    const titleTokens = new Set(tokenize(node.title));
    const titleMatches = queryTokens.length
      ? queryTokens.filter((token) => titleTokens.has(token)).length / queryTokens.length
      : 0;
    const scopeScore = scopeMatchScore(node.scope, queryScope);
    const statusScore = node.status === "active" ? 0.05 : -0.06;
    const basisScore = node.basis === "verified" ? 0.08 : node.basis === "cited" ? 0.04 : -0.02;
    const confidenceScore = node.confidence * 0.08;
    const ageDays = Math.max(0, (Date.now() - Date.parse(node.updatedAt)) / 86_400_000);
    const recencyScore = (1 / (1 + ageDays / 45)) * 0.05;
    const score =
      lexical + titleMatches * 0.45 + scopeScore + statusScore + basisScore + confidenceScore + recencyScore;

    const nextReasons = [...reasons];
    if (titleMatches > 0) nextReasons.push("title");
    if (scopeScore > 0) nextReasons.push("scope");
    if (node.basis === "verified" || node.basis === "cited") nextReasons.push(node.basis);
    if (node.status !== "active") nextReasons.push(node.status);

    return { node, score, reasons: nextReasons };
  }

  get(id: string): MemoryDetail | undefined {
    const row = this.getRow(id);
    if (!row) return undefined;
    const node = this.rowToNode(row);
    const versions = this.db
      .prepare("SELECT * FROM node_versions WHERE node_id = ? ORDER BY version DESC")
      .all(id)
      .map((version) => this.rowToVersion(version));
    return {
      node,
      versions,
      citations: this.getCitations(node.id, node.version),
      edges: this.getEdges(node.id),
      audits: this.getAudits(node.id),
      injections: this.getInjections(node.id),
    };
  }

  neighbors(id: string, options: NeighborOptions = {}): NeighborResult | undefined {
    const rootRow = this.getRow(id);
    if (!rootRow) return undefined;
    const root = this.rowToNode(rootRow);
    const depth = clamp(Math.floor(options.depth ?? 1), 1, 3);
    const limit = clamp(Math.floor(options.limit ?? 40), 1, 100);
    const direction = options.direction ?? "both";
    const edgeTypes = options.edgeTypes?.length ? new Set(options.edgeTypes) : undefined;
    const visited = new Set<string>([id]);
    const neighbors: Neighbor[] = [];
    let frontier = [id];

    for (let level = 1; level <= depth && neighbors.length < limit; level++) {
      const next: string[] = [];
      for (const current of frontier) {
        for (const edge of this.getEdges(current)) {
          if (edgeTypes && !edgeTypes.has(edge.type)) continue;
          const outgoing = edge.fromID === current;
          if (direction === "out" && !outgoing) continue;
          if (direction === "in" && outgoing) continue;
          const neighborID = outgoing ? edge.toID : edge.fromID;
          if (visited.has(neighborID)) continue;
          visited.add(neighborID);
          const row = this.getRow(neighborID);
          if (!row) continue;
          neighbors.push({
            node: this.rowToNode(row),
            edge,
            direction: outgoing ? "out" : "in",
            depth: level,
          });
          next.push(neighborID);
          if (neighbors.length >= limit) break;
        }
        if (neighbors.length >= limit) break;
      }
      frontier = next;
      if (!frontier.length) break;
    }

    return { node: root, neighbors };
  }

  citationChecks(
    id: string,
    options: SourceSnapshotOptions & { includeContent?: boolean } = {},
  ): CitationCheck[] {
    const row = this.getRow(id);
    if (!row) return [];
    const node = this.rowToNode(row);
    return this.getCitations(node.id, node.version).map((citation) => {
      if (citation.type !== "file") {
        return { nodeID: node.id, citation, status: "unchecked" as const };
      }
      const absolute = path.isAbsolute(citation.locator)
        ? citation.locator
        : path.resolve(this.projectRoot, citation.locator);
      try {
        const content = readFileSync(absolute);
        if (citation.contentHash && sha256(content) !== citation.contentHash) {
          return { nodeID: node.id, citation, status: "changed" as const };
        }
        return {
          nodeID: node.id,
          citation,
          status: "ok" as const,
          ...(options.includeContent
            ? { snapshot: buildCitationSnapshot(citation, content, options) }
            : {}),
        };
      } catch {
        return { nodeID: node.id, citation, status: "missing" as const };
      }
    });
  }

  cite(id: string, citations: CitationInput[], context: WriteContext): MemoryNode {
    return transaction(this.db, () => {
      const row = this.getRow(id);
      if (!row) throw new Error(`No memory node found for ${id}`);
      const node = this.rowToNode(row);
      if (node.status === "archived" || node.status === "superseded") {
        throw new Error(`Cannot add citations to a ${node.status} node.`);
      }
      if (!citations.length) throw new Error("At least one citation is required.");
      const resolved = this.resolveCitations(citations);
      const missing = resolved.filter((citation) => citation.validation === "missing");
      if (missing.length) {
        throw new Error(
          `Citation file(s) missing: ${missing.map((citation) => citation.input.locator).join(", ")}`,
        );
      }
      this.insertCitations(node.id, node.version, resolved);
      const now = this.now();
      const next: MemoryNode = { ...node, updatedAt: now };
      this.updateNodeRow(next);
      this.recordEvent(context.author, "cite", node.id, { citations: citations.length });
      return next;
    });
  }

  link(from: string, to: string, type: EdgeType, context: WriteContext, weight = 1): Edge {
    return transaction(this.db, () => {
      if (from === to) throw new Error("Cannot link a node to itself.");
      if (type === "supersedes" || type === "contradicts") {
        throw new Error(`Use the revision workflow for ${type} edges.`);
      }
      const fromRow = this.getRow(from);
      const toRow = this.getRow(to);
      if (!fromRow || !toRow) throw new Error(`Both nodes must exist: ${from}, ${to}`);
      const fromNode = this.rowToNode(fromRow);
      const toNode = this.rowToNode(toRow);
      for (const node of [fromNode, toNode]) {
        if (node.status === "archived" || node.status === "superseded") {
          throw new Error(`Cannot link a ${node.status} node (${node.id}).`);
        }
      }

      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO edges(from_id, to_id, type, weight, metadata_json, created_at)
           VALUES(?, ?, ?, ?, '{}', ?)
           ON CONFLICT(from_id, to_id, type) DO UPDATE SET
             retired_at = NULL,
             weight = excluded.weight,
             metadata_json = excluded.metadata_json,
             created_at = excluded.created_at`,
        )
        .run(from, to, type, weight, now);
      const edgeRow = this.db
        .prepare("SELECT * FROM edges WHERE from_id = ? AND to_id = ? AND type = ?")
        .get(from, to, type);
      if (!edgeRow) throw new Error(`Failed to create ${type} edge.`);
      this.recordEvent(context.author, "link", from, { to, type, weight });
      return this.rowToEdge(edgeRow);
    });
  }

  unlink(from: string, to: string, type: EdgeType, context: WriteContext): boolean {
    return transaction(this.db, () => {
      const result = this.db
        .prepare(
          `UPDATE edges SET retired_at = ?
           WHERE from_id = ? AND to_id = ? AND type = ? AND retired_at IS NULL`,
        )
        .run(this.now(), from, to, type);
      const changed = Number(result.changes) > 0;
      if (changed) this.recordEvent(context.author, "unlink", from, { to, type });
      return changed;
    });
  }

  update(
    id: string,
    patch: { title?: string; scope?: string[]; tags?: string[]; reason?: string },
    context: WriteContext,
  ): MemoryNode {
    return transaction(this.db, () => {
      const row = this.getRow(id);
      if (!row) throw new Error(`No memory node found for ${id}`);
      const node = this.rowToNode(row);
      if (node.status === "archived" || node.status === "superseded") {
        throw new Error(`Cannot update a ${node.status} node.`);
      }
      const title = patch.title !== undefined ? normalizeText(patch.title) : node.title;
      if (!title) throw new Error("Title cannot be empty.");
      const canonical = canonicalKey(node.kind, title);
      const collision = this.getRowByCanonical(canonical);
      if (collision && String(collision.id) !== node.id) {
        throw new Error(`Another node already uses that title: ${String(collision.id)}`);
      }
      const scope = patch.scope !== undefined ? uniqueStrings(patch.scope) : node.scope;
      const tags = patch.tags !== undefined ? uniqueStrings(patch.tags) : node.tags;
      const now = this.now();
      const metadata =
        patch.title !== undefined && normalizeText(patch.title) !== node.title
          ? { ...node.metadata, renamedFrom: node.title, renamedAt: now }
          : { ...node.metadata };
      const next: MemoryNode = {
        ...node,
        title,
        scope,
        tags,
        updatedAt: now,
        metadata,
      };
      this.updateNodeRow(next);
      this.recordEvent(context.author, "update", node.id, {
        titleChanged: next.title !== node.title,
        scopeChanged: JSON.stringify(next.scope) !== JSON.stringify(node.scope),
        tagsChanged: JSON.stringify(next.tags) !== JSON.stringify(node.tags),
        reason: patch.reason,
      });
      return next;
    });
  }

  archive(id: string, context: WriteContext, reason: string): MemoryNode {
    return transaction(this.db, () => {
      const row = this.getRow(id);
      if (!row) throw new Error(`No memory node found for ${id}`);
      const node = this.rowToNode(row);
      if (node.status === "archived") return node;
      const now = this.now();
      const next: MemoryNode = {
        ...node,
        status: "archived",
        autoInjectEligible: false,
        updatedAt: now,
        metadata: { ...node.metadata, archiveReason: reason, archivedAt: now },
      };
      this.updateNodeRow(next);
      this.recordEvent(context.author, "archive", id, { reason });
      return next;
    });
  }

  confirm(id: string, input: { as?: "cited" | "derived" | "verified"; author: Author; reason?: string }): MemoryNode | undefined {
    return transaction(this.db, () => {
      const row = this.getRow(id);
      if (!row) return undefined;
      const current = this.rowToNode(row);
      const citations = this.getCitations(current.id, current.version);
      if (input.as === "cited") {
        if (citations.length === 0) {
          throw new Error("Cannot confirm as cited without a citation.");
        }
        if (citations.some((citation) => citation.validation === "missing")) {
          throw new Error("Cannot confirm as cited while a cited file is missing.");
        }
      }
      if (input.as === "derived") {
        const premiseEdges = this.getEdges(id).filter(
          (edge) => edge.type === "derived_from" && edge.fromID === id,
        );
        if (!premiseEdges.length) {
          throw new Error("Cannot confirm as derived without a derived_from premise.");
        }
        for (const edge of premiseEdges) {
          const premiseRow = this.getRow(edge.toID);
          if (!premiseRow) throw new Error(`Derived premise ${edge.toID} does not exist.`);
          const premise = this.rowToNode(premiseRow);
          if (premise.status !== "active") {
            throw new Error(`Derived premise ${premise.id} is ${premise.status}.`);
          }
          if (premise.basis === "inferred") {
            throw new Error(`Derived premise ${premise.id} is inferred.`);
          }
          if (premise.basis === "derived" && premise.verificationState !== "confirmed") {
            throw new Error(`Derived premise ${premise.id} is unconfirmed.`);
          }
          if (
            premise.verificationState === "rejected" ||
            premise.verificationState === "needs_human"
          ) {
            throw new Error(
              `Derived premise ${premise.id} is ${premise.verificationState}.`,
            );
          }
        }
      }
      const nextBasis = input.as ?? (citations.length ? "cited" : "verified");
      const now = this.now();
      const metadata = { ...current.metadata };
      delete metadata.ratificationSuggested;
      const next: MemoryNode = this.recomputeEligibility({
        ...current,
        basis: nextBasis,
        verificationState: "confirmed",
        status: "active",
        confidence: Math.max(current.confidence, nextBasis === "verified" ? 0.9 : 0.7),
        version: current.version + 1,
        updatedAt: now,
        lastConfirmedAt: now,
        materialRevisionAt: now,
        author: input.author,
        metadata,
      });
      this.updateNodeRow(next);
      this.insertVersion(next, input.reason ?? "confirmed", []);
      this.copyCitations(current.id, current.version, next.version);
      this.recordEvent(input.author, "confirm", next.id, {
        from: current.verificationState,
        basis: nextBasis,
        reason: input.reason,
      });
      return next;
    });
  }

  reject(id: string, input: { author: Author; reason: string }): MemoryNode | undefined {
    return transaction(this.db, () => {
      const row = this.getRow(id);
      if (!row) return undefined;
      const current = this.rowToNode(row);
      const now = this.now();
      const metadata: Record<string, unknown> = {
        ...current.metadata,
        rejectionReason: input.reason,
      };
      delete metadata.ratificationSuggested;
      const next: MemoryNode = {
        ...current,
        verificationState: "rejected",
        status: "active",
        version: current.version + 1,
        updatedAt: now,
        autoInjectEligible: false,
        author: input.author,
        metadata,
      };
      this.updateNodeRow(next);
      this.insertVersion(next, "rejected", []);
      this.copyCitations(current.id, current.version, next.version);
      this.recordEvent(input.author, "reject", next.id, { reason: input.reason });
      return next;
    });
  }

  markStale(id: string, author: Author, reason: string): MemoryNode | undefined {
    return transaction(this.db, () => {
      const row = this.getRow(id);
      if (!row) return undefined;
      const current = this.rowToNode(row);
      const next: MemoryNode = {
        ...current,
        status: "stale",
        autoInjectEligible: false,
        updatedAt: this.now(),
      };
      this.updateNodeRow(next);
      this.recordEvent(author, "stale", next.id, { reason });
      return next;
    });
  }

  markDisputed(id: string, author: Author, reason: string): MemoryNode | undefined {
    return transaction(this.db, () => {
      const row = this.getRow(id);
      if (!row) return undefined;
      const current = this.rowToNode(row);
      const next: MemoryNode = {
        ...current,
        status: "disputed",
        autoInjectEligible: false,
        updatedAt: this.now(),
      };
      this.updateNodeRow(next);
      this.recordEvent(author, "disputed", next.id, { reason });
      return next;
    });
  }

  revalidate(): { checked: number; markedStale: number } {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT n.*
         FROM nodes n
         JOIN citations c ON c.node_id = n.id AND c.node_version = n.current_version
         JOIN sources s ON s.id = c.source_id
         WHERE s.type = 'file' AND n.status != 'stale'`,
      )
      .all();
    let markedStale = 0;
    for (const row of rows) {
      const node = this.rowToNode(row);
      const citations = this.getCitations(node.id, node.version).filter((citation) => citation.type === "file");
      let changed = false;
      for (const citation of citations) {
        const absolute = path.isAbsolute(citation.locator)
          ? citation.locator
          : path.resolve(this.projectRoot, citation.locator);
        try {
          const content = readFileSync(absolute);
          if (citation.contentHash && sha256(content) !== citation.contentHash) changed = true;
        } catch {
          changed = true;
        }
      }
      if (changed) {
        this.markStale(node.id, { type: "system", id: "revalidate" }, "A cited file changed or disappeared.");
        markedStale++;
      }
    }
    return { checked: rows.length, markedStale };
  }

  review(): ReviewItem[] {
    const rows = this.db
      .prepare("SELECT * FROM nodes ORDER BY updated_at DESC LIMIT 1000")
      .all();
    return rows
      .map((row) => {
        const node = this.rowToNode(row);
        const reasons: string[] = [];
        if (node.verificationState === "unverified") {
          reasons.push(
            node.basis === "derived"
              ? "derived claim awaiting verification"
              : "inferred claim awaiting verification",
          );
        }
        if (node.verificationState === "queued") reasons.push("verification queued");
        if (node.verificationState === "needs_human") reasons.push("needs human review");
        if (node.verificationState === "rejected") reasons.push("previous verification rejected");
        if (node.metadata.ratificationSuggested) reasons.push("verified ratification suggested");
        if (node.status === "disputed") reasons.push("disputed");
        if (node.status === "stale") reasons.push("stale citation");
        return { node, reasons };
      })
      .filter(
        (item) =>
          item.reasons.length > 0 &&
          item.node.status !== "archived" &&
          item.node.status !== "superseded",
      )
      .slice(0, 100);
  }

  getConflictProposal(nodeA: string, nodeB: string): ConflictProposal | undefined {
    const [a, b] = canonicalPair(nodeA, nodeB);
    const row = this.db
      .prepare("SELECT * FROM conflict_proposals WHERE node_a = ? AND node_b = ?")
      .get(a, b);
    return row ? this.rowToConflictProposal(row) : undefined;
  }

  conflictProposals(
    options: { status?: ConflictStatus; limit?: number } = {},
  ): ConflictProposal[] {
    const limit = clamp(Math.floor(options.limit ?? 50), 1, 200);
    const rows = options.status
      ? this.db
          .prepare(
            "SELECT * FROM conflict_proposals WHERE status = ? ORDER BY updated_at DESC LIMIT ?",
          )
          .all(options.status, limit)
      : this.db
          .prepare("SELECT * FROM conflict_proposals ORDER BY updated_at DESC LIMIT ?")
          .all(limit);
    return rows
      .map((row) => this.rowToConflictProposal(row))
      .filter((proposal): proposal is ConflictProposal => Boolean(proposal));
  }

  upsertConflictProposal(
    input: ConflictProposalInput,
    author: Author = { type: "system", id: "conflict-discovery" },
  ): ConflictProposal | undefined {
    return transaction(this.db, () => {
      const [a, b] = canonicalPair(input.nodeA, input.nodeB);
      const aRow = this.getRow(a);
      const bRow = this.getRow(b);
      if (!aRow || !bRow) return undefined;
      const nodeA = this.rowToNode(aRow);
      const nodeB = this.rowToNode(bRow);
      const existing = this.getConflictProposal(a, b);
      if (existing?.status === "confirmed") return existing;
      if (
        existing?.status === "dismissed" &&
        existing.nodeAVersion === nodeA.version &&
        existing.nodeBVersion === nodeB.version
      ) {
        return existing;
      }
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO conflict_proposals
            (node_a, node_b, node_a_version, node_b_version, status, relation,
             reason, evidence_json, input_hash, created_at, updated_at)
           VALUES(?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?)
           ON CONFLICT(node_a, node_b) DO UPDATE SET
             node_a_version = excluded.node_a_version,
             node_b_version = excluded.node_b_version,
             status = 'proposed',
             relation = excluded.relation,
             confidence = 0,
             reason = excluded.reason,
             evidence_json = excluded.evidence_json,
             input_hash = excluded.input_hash,
             updated_at = excluded.updated_at`,
        )
        .run(
          a,
          b,
          nodeA.version,
          nodeB.version,
          input.relation,
          input.reason,
          JSON.stringify(input.evidence),
          input.inputHash,
          now,
          now,
        );
      this.recordEvent(author, "conflict_propose", a, {
        target: b,
        relation: input.relation,
      });
      return this.getConflictProposal(a, b);
    });
  }

  confirmConflict(
    nodeA: string,
    nodeB: string,
    author: Author,
    reason: string,
  ): ConflictProposal | undefined {
    return transaction(this.db, () => {
      const [a, b] = canonicalPair(nodeA, nodeB);
      const proposal = this.getConflictProposal(a, b);
      if (!proposal) throw new Error(`No conflict proposal found for ${a} and ${b}`);
      if (proposal.stale) {
        throw new Error("Conflict proposal is stale; run conflict discovery again.");
      }
      for (const node of [proposal.nodeA, proposal.nodeB]) {
        if (node.status === "archived" || node.status === "superseded") {
          throw new Error(`Cannot confirm a conflict involving a ${node.status} claim.`);
        }
      }
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO edges(from_id, to_id, type, weight, metadata_json, created_at)
           VALUES(?, ?, 'contradicts', 1, '{}', ?)
           ON CONFLICT(from_id, to_id, type) DO UPDATE SET retired_at = NULL`,
        )
        .run(a, b, now);
      const update = this.db.prepare(
        `UPDATE nodes SET status = 'disputed', auto_inject_eligible = 0, updated_at = ?
         WHERE id = ?`,
      );
      update.run(now, a);
      update.run(now, b);
      this.db
        .prepare(
          "UPDATE conflict_proposals SET status = 'confirmed', updated_at = ? WHERE node_a = ? AND node_b = ?",
        )
        .run(now, a, b);
      const audit = this.db.prepare(
        `INSERT INTO audits
          (node_id, node_version, trigger, sampled_by, risk_score, auditor_json,
           outcome, findings_json, created_at)
         VALUES(?, ?, 'manual', 'conflict_confirm', 0, ?, 'contradicted', ?, ?)`,
      );
      audit.run(
        proposal.nodeA.id,
        proposal.nodeA.version,
        JSON.stringify(author),
        JSON.stringify({ kind: "conflict_confirm", target: proposal.nodeB.id, reason }),
        now,
      );
      audit.run(
        proposal.nodeB.id,
        proposal.nodeB.version,
        JSON.stringify(author),
        JSON.stringify({ kind: "conflict_confirm", target: proposal.nodeA.id, reason }),
        now,
      );
      this.recordEvent(author, "conflict_confirm", a, { target: b, reason });
      return this.getConflictProposal(a, b);
    });
  }

  dismissConflict(
    nodeA: string,
    nodeB: string,
    author: Author,
    reason: string,
  ): ConflictProposal | undefined {
    return transaction(this.db, () => {
      const [a, b] = canonicalPair(nodeA, nodeB);
      const proposal = this.getConflictProposal(a, b);
      if (!proposal) throw new Error(`No conflict proposal found for ${a} and ${b}`);
      if (proposal.status === "confirmed") {
        throw new Error("A confirmed conflict cannot be dismissed.");
      }
      const now = this.now();
      this.db
        .prepare(
          "UPDATE conflict_proposals SET status = 'dismissed', updated_at = ? WHERE node_a = ? AND node_b = ?",
        )
        .run(now, a, b);
      this.recordEvent(author, "conflict_dismiss", a, { target: b, reason });
      return this.getConflictProposal(a, b);
    });
  }

  findConflictScan(nodeID: string, inputHash: string): AuditInfo | undefined {
    return this.db
      .prepare(
        `SELECT * FROM audits
         WHERE node_id = ? AND sampled_by = 'memory_conflicts'
         ORDER BY created_at DESC, id DESC
         LIMIT 20`,
      )
      .all(nodeID)
      .map((row) => this.rowToAudit(row))
      .find(
        (audit) =>
          audit.findings.inputHash === inputHash && audit.findings.cacheable === true,
      );
  }

  recordConflictScan(
    nodeID: string,
    inputHash: string,
    outcome: "no_conflict" | "conflict_proposed",
    findings: Record<string, unknown>,
    author: Author,
  ): void {
    const row = this.getRow(nodeID);
    if (!row) return;
    const node = this.rowToNode(row);
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO audits
          (node_id, node_version, trigger, sampled_by, risk_score, auditor_json,
           outcome, findings_json, created_at)
         VALUES(?, ?, 'verification', 'memory_conflicts', 0, ?, ?, ?, ?)`,
      )
      .run(
        node.id,
        node.version,
        JSON.stringify({ tool: "memory_conflicts" }),
        outcome,
        JSON.stringify({
          ...findings,
          kind: "conflict_scan",
          inputHash,
          cacheable: true,
        }),
        now,
      );
    this.recordEvent(author, "conflict_scan", node.id, {
      inputHash,
      outcome,
    });
  }

  private rowToConflictProposal(row: Row): ConflictProposal | undefined {
    const aRow = this.getRow(String(row.node_a));
    const bRow = this.getRow(String(row.node_b));
    if (!aRow || !bRow) return undefined;
    const nodeA = this.rowToNode(aRow);
    const nodeB = this.rowToNode(bRow);
    const status = String(row.status) as ConflictStatus;
    const nodeAVersion = Number(row.node_a_version);
    const nodeBVersion = Number(row.node_b_version);
    return {
      id: Number(row.id),
      nodeA,
      nodeB,
      nodeAVersion,
      nodeBVersion,
      status,
      relation: String(row.relation) as ConflictProposal["relation"],
      reason: String(row.reason),
      evidence: parseJson<ConflictProposal["evidence"]>(row.evidence_json, []),
      inputHash: String(row.input_hash),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      stale:
        status === "proposed" &&
        (nodeA.version !== nodeAVersion || nodeB.version !== nodeBVersion),
    };
  }

  stats(): MemoryStats {
    const nodes = Number(this.db.prepare("SELECT COUNT(*) AS count FROM nodes").get()?.count ?? 0);
    const events = Number(this.db.prepare("SELECT COUNT(*) AS count FROM events").get()?.count ?? 0);
    const injections = Number(this.db.prepare("SELECT COUNT(*) AS count FROM injections").get()?.count ?? 0);
    const audits = Number(this.db.prepare("SELECT COUNT(*) AS count FROM audits").get()?.count ?? 0);
    return {
      nodes: { total: nodes },
      statuses: groupCount(this.db, "status"),
      bases: groupCount(this.db, "basis"),
      kinds: groupCount(this.db, "kind"),
      verification: groupCount(this.db, "verification_state"),
      events,
      injections,
      audits,
    };
  }

  status(): MemoryStatus {
    const stats = this.stats();
    const total = stats.nodes.total;
    const overviewNode = this.get("concept/project-overview")?.node;
    const overview = Boolean(
      overviewNode && overviewNode.status !== "archived" && overviewNode.status !== "superseded",
    );
    const components = stats.kinds.component ?? 0;
    const decisions = (stats.kinds.decision ?? 0) + (stats.kinds.pattern ?? 0);
    const gotchas = (stats.kinds.gotcha ?? 0) + (stats.kinds.runbook ?? 0);
    const state: OnboardingState =
      total === 0
        ? "empty"
        : !overview || components === 0
          ? "recommended"
          : decisions === 0 || gotchas === 0
            ? "partial"
            : "complete";

    return {
      total,
      kinds: stats.kinds,
      bases: stats.bases,
      statuses: stats.statuses,
      overview,
      state,
      onboardingRecommended: state === "empty" || state === "recommended",
    };
  }

  list(query: MemoryListQuery = {}): MemoryListResult {
    const limit = clamp(Math.floor(query.limit ?? 50), 1, 100);
    const offset = Math.max(0, Math.floor(query.offset ?? 0));
    const rows = this.db.prepare("SELECT * FROM nodes ORDER BY updated_at DESC, id ASC").all();
    const filtered = rows
      .map((row) => this.rowToNode(row))
      .filter((node) => {
        if (query.kinds?.length && !query.kinds.includes(node.kind)) return false;
        if (query.statuses?.length && !query.statuses.includes(node.status)) return false;
        if (query.bases?.length && !query.bases.includes(node.basis)) return false;
        if (query.tag && !node.tags.includes(query.tag)) return false;
        if (query.scope && node.scope.length && !anyScopeMatches(node.scope, [query.scope])) return false;
        return true;
      });

    const total = filtered.length;
    const page = filtered.slice(offset, offset + limit);
    const citationCount = this.db.prepare(
      "SELECT COUNT(*) AS count FROM citations WHERE node_id = ? AND node_version = ?",
    );
    const edgeCount = this.db.prepare(
      "SELECT COUNT(*) AS count FROM edges WHERE (from_id = ? OR to_id = ?) AND retired_at IS NULL",
    );
    const items: MemoryListItem[] = page.map((node) => ({
      id: node.id,
      kind: node.kind,
      title: node.title,
      status: node.status,
      basis: node.basis,
      confidence: node.confidence,
      verificationState: node.verificationState,
      scope: node.scope,
      tags: node.tags,
      citationCount: Number(citationCount.get(node.id, node.version)?.count ?? 0),
      edgeCount: Number(edgeCount.get(node.id, node.id)?.count ?? 0),
      updatedAt: node.updatedAt,
    }));

    return {
      total,
      items,
      nextOffset: offset + items.length < total ? offset + items.length : undefined,
    };
  }

  health(): MemoryHealth {
    const stats = this.stats();
    const all = this.db.prepare("SELECT * FROM nodes").all().map((row) => this.rowToNode(row));
    const activeNodes = all.filter((node) => node.status === "active");
    const citationCount = this.db.prepare(
      "SELECT COUNT(*) AS count FROM citations WHERE node_id = ? AND node_version = ?",
    );
    const edgeCount = this.db.prepare(
      "SELECT COUNT(*) AS count FROM edges WHERE (from_id = ? OR to_id = ?) AND retired_at IS NULL",
    );
    const hasCitation = (node: MemoryNode) =>
      Number(citationCount.get(node.id, node.version)?.count ?? 0) > 0;
    const hasEdges = (node: MemoryNode) => Number(edgeCount.get(node.id, node.id)?.count ?? 0) > 0;
    const issue = (node: MemoryNode, reasons: string[]): HealthIssue => ({
      id: node.id,
      title: node.title,
      reasons,
    });
    const issueList = (nodes: MemoryNode[], reasons: (node: MemoryNode) => string[]): HealthIssue[] =>
      nodes.slice(0, 20).map((node) => issue(node, reasons(node)));

    const uncitedNodes = activeNodes.filter((node) => !hasCitation(node));
    const staleNodes = all.filter((node) => node.status === "stale");
    const disputedNodes = all.filter((node) => node.status === "disputed");
    const orphanedNodes = activeNodes.filter((node) => !hasEdges(node));
    const lowConfidenceNodes = activeNodes.filter((node) => node.confidence < 0.6);
    const verificationBacklogNodes = all.filter(
      (node) =>
        node.status !== "archived" &&
        node.status !== "superseded" &&
        ["unverified", "queued", "needs_human"].includes(node.verificationState),
    );
    const auditCutoff = new Date(this.nowFn().getTime() - 30 * 86_400_000).toISOString();
    const hasRecentAudit = this.db.prepare(
      "SELECT 1 FROM audits WHERE node_id = ? AND created_at >= ? LIMIT 1",
    );
    const auditBacklogNodes = all.filter(
      (node) => node.autoInjectEligible && !hasRecentAudit.get(node.id, auditCutoff),
    );
    const renamedNodes = all.filter(
      (node) =>
        node.status !== "archived" &&
        node.status !== "superseded" &&
        node.id !== baseNodeId(node.kind, node.title),
    );
    const ratificationNodes = all.filter(
      (node) =>
        Boolean(node.metadata.ratificationSuggested) &&
        node.status !== "archived" &&
        node.status !== "superseded",
    );

    const overviewNode = this.get("concept/project-overview")?.node;
    const overviewPresent = Boolean(
      overviewNode && overviewNode.status !== "archived" && overviewNode.status !== "superseded",
    );
    const linkedComponents = Number(
      this.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM edges e
           JOIN nodes n ON n.id = e.from_id
           WHERE e.type = 'part_of' AND e.to_id = ? AND e.retired_at IS NULL AND n.kind = 'component'`,
        )
        .get("concept/project-overview")?.count ?? 0,
    );

    return {
      generatedAt: this.now(),
      total: all.length,
      active: activeNodes.length,
      statuses: stats.statuses,
      bases: stats.bases,
      kinds: stats.kinds,
      onboarding: this.status().state,
      overview: { present: overviewPresent, linkedComponents },
      citationCoverage: activeNodes.length
        ? activeNodes.filter((node) => hasCitation(node)).length / activeNodes.length
        : 0,
      counts: {
        uncited: uncitedNodes.length,
        stale: staleNodes.length,
        disputed: disputedNodes.length,
        orphaned: orphanedNodes.length,
        lowConfidence: lowConfidenceNodes.length,
        verificationBacklog: verificationBacklogNodes.length,
        auditBacklog: auditBacklogNodes.length,
        renamedIds: renamedNodes.length,
        ratificationSuggested: ratificationNodes.length,
      },
      uncited: issueList(uncitedNodes, () => ["no citations"]),
      stale: issueList(staleNodes, () => ["status stale"]),
      disputed: issueList(disputedNodes, () => ["status disputed"]),
      orphaned: issueList(orphanedNodes, () => ["no active edges"]),
      lowConfidence: issueList(lowConfidenceNodes, (node) => [
        `confidence ${node.confidence.toFixed(2)} < 0.60`,
      ]),
      verificationBacklog: issueList(verificationBacklogNodes, (node) => [
        `verification ${node.verificationState}`,
      ]),
      auditBacklog: issueList(auditBacklogNodes, () => ["no audit in 30 days"]),
      renamedIds: issueList(renamedNodes, (node) => [
        `ID ${node.id} does not match title slug ${baseNodeId(node.kind, node.title)}`,
      ]),
      ratificationSuggested: issueList(ratificationNodes, () => [
        "model suggests ratification to verified",
      ]),
    };
  }

  verificationCandidates(options: { scope?: string; limit?: number } = {}): MemoryNode[] {
    const limit = clamp(Math.floor(options.limit ?? 10), 1, 100);
    const rows = this.db
      .prepare(
        `SELECT * FROM nodes
         WHERE status IN ('active', 'stale')
           AND verification_state IN ('unverified', 'queued', 'needs_human')
         ORDER BY updated_at DESC`,
      )
      .all();
    return rows
      .map((row) => this.rowToNode(row))
      .filter(
        (node) =>
          !options.scope ||
          !node.scope.length ||
          anyScopeMatches(node.scope, [options.scope]),
      )
      .slice(0, limit);
  }

  applyVerification(id: string, input: ApplyVerificationInput): MemoryNode {
    return transaction(this.db, () => {
      const row = this.getRow(id);
      if (!row) throw new Error(`No memory node found for ${id}`);
      const current = this.rowToNode(row);
      const now = this.now();
      const next: MemoryNode = this.recomputeEligibility({
        ...current,
        ...(input.basis !== undefined ? { basis: input.basis } : {}),
        ...(input.verificationState !== undefined
          ? { verificationState: input.verificationState }
          : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.confidence !== undefined ? { confidence: clamp(input.confidence, 0, 1) } : {}),
        ...(input.lastConfirmedAt !== undefined
          ? { lastConfirmedAt: input.lastConfirmedAt }
          : {}),
        ...(input.metadata ? { metadata: { ...current.metadata, ...input.metadata } } : {}),
        updatedAt: now,
      });
      this.updateNodeRow(next);
      this.db
        .prepare(
          `INSERT INTO audits
            (node_id, node_version, trigger, sampled_by, risk_score, auditor_json,
             outcome, findings_json, created_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          next.id,
          current.version,
          input.audit.trigger,
          input.audit.sampledBy ?? "verification",
          input.audit.riskScore ?? 0,
          JSON.stringify(input.audit.auditor ?? {}),
          input.audit.outcome,
          JSON.stringify(input.audit.findings ?? {}),
          now,
        );

      for (const conflictID of new Set(input.conflictIDs ?? [])) {
        if (conflictID === id) continue;
        const otherRow = this.getRow(conflictID);
        if (!otherRow) continue;
        const other = this.rowToNode(otherRow);
        if (other.status === "archived") continue;
        this.updateNodeRow({
          ...other,
          status: "disputed",
          autoInjectEligible: false,
          updatedAt: now,
        });
        this.db
          .prepare(
            `INSERT INTO edges(from_id, to_id, type, weight, metadata_json, created_at)
             VALUES(?, ?, 'contradicts', 1, '{}', ?)
             ON CONFLICT(from_id, to_id, type) DO UPDATE SET retired_at = NULL`,
          )
          .run(next.id, conflictID, now);
        this.recordEvent(input.author, "dispute", next.id, {
          target: conflictID,
          reason: input.reason,
        });
      }

      this.recordEvent(
        input.author,
        input.audit.trigger === "verification" ? "verify" : "audit",
        next.id,
        { outcome: input.audit.outcome, reason: input.reason },
      );
      return next;
    });
  }

  auditCandidates(options: { uniformRate?: number; riskRate?: number; max?: number } = {}): AuditCandidate[] {
    const uniformRate = clamp(options.uniformRate ?? 0.03, 0, 1);
    const riskRate = clamp(options.riskRate ?? 0.07, 0, 1);
    const max = clamp(Math.floor(options.max ?? 25), 1, 500);
    const rows = this.db.prepare("SELECT * FROM nodes WHERE auto_inject_eligible = 1").all();
    if (!rows.length) return [];

    const injectionCounts = new Map<string, number>();
    for (const row of this.db.prepare("SELECT node_id, COUNT(*) AS count FROM injections GROUP BY node_id").all()) {
      injectionCounts.set(String(row.node_id), Number(row.count));
    }
    const lastAudit = this.db.prepare(
      "SELECT node_version, created_at FROM audits WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    );
    const auditCutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();

    const candidates = rows.map((row) => {
      const node = this.rowToNode(row);
      const reasons: string[] = [];
      const uniform =
        Number.parseInt(shortHash(`${node.id}:${node.version}:uniform`), 16) / 0xffffffff < uniformRate;
      if (uniform) reasons.push("uniform sample");

      let risk = 0;
      if (node.confidence < 0.7) {
        risk += 0.2;
        reasons.push("low confidence");
      }
      if (node.basis === "cited") {
        risk += 0.1;
        reasons.push("cited but not verified");
      }
      if (node.verificationState !== "not_required") {
        risk += 0.15;
        reasons.push("verification state");
      }
      const injections = injectionCounts.get(node.id) ?? 0;
      if (injections) {
        risk += Math.min(0.3, (injections / 20) * 0.3);
        reasons.push(`injected ${injections} times`);
      }
      const ageDays = Math.max(0, (Date.now() - Date.parse(node.updatedAt)) / 86_400_000);
      if (ageDays > 14) {
        risk += Math.min(0.2, (ageDays / 90) * 0.2);
        reasons.push("not recently confirmed");
      }
      if (this.policy.strict.some((rule) => anyScopeMatches([rule.pattern], node.scope))) {
        risk += 0.15;
        reasons.push("strict scope");
      }
      return { node, uniform, risk: clamp(risk, 0, 1), reasons };
    }).filter((candidate) => {
      const audit = lastAudit.get(candidate.node.id);
      if (!audit) return true;
      const sameVersion = Number(audit.node_version) >= candidate.node.version;
      return !(sameVersion && String(audit.created_at) >= auditCutoff);
    });

    const selected = new Map<string, AuditCandidate>();
    for (const candidate of candidates.filter((candidate) => candidate.uniform)) {
      selected.set(candidate.node.id, {
        node: candidate.node,
        trigger: "uniform",
        riskScore: candidate.risk,
        reasons: candidate.reasons,
      });
    }

    const riskSlots =
      riskRate <= 0 ? 0 : Math.max(1, Math.ceil(candidates.length * riskRate));
    for (const candidate of [...candidates].sort((left, right) => right.risk - left.risk).slice(0, riskSlots)) {
      if (selected.has(candidate.node.id)) continue;
      selected.set(candidate.node.id, {
        node: candidate.node,
        trigger: "risk",
        riskScore: candidate.risk,
        reasons: candidate.reasons,
      });
    }

    return [...selected.values()].slice(0, max);
  }

  recordAudit(input: AuditRecordInput): void {
    transaction(this.db, () => {
      const row = this.getRow(input.nodeID);
      if (!row) return;
      const current = this.rowToNode(row);
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO audits
            (node_id, node_version, trigger, sampled_by, risk_score, auditor_json, outcome, findings_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          current.id,
          input.version || current.version,
          input.trigger,
          input.sampledBy ?? "manual",
          input.riskScore ?? 0,
          JSON.stringify(input.auditor ?? {}),
          input.outcome,
          JSON.stringify(input.findings ?? {}),
          now,
        );

      let next: MemoryNode = current;
      if (input.outcome === "stale") {
        next = { ...current, status: "stale", autoInjectEligible: false, updatedAt: now };
      } else if (input.outcome === "contradicted") {
        next = { ...current, status: "disputed", autoInjectEligible: false, updatedAt: now };
      } else if (input.outcome === "malicious") {
        next = { ...current, status: "archived", autoInjectEligible: false, updatedAt: now };
      } else if (input.outcome === "insufficient" || input.outcome === "needs_human") {
        next = {
          ...current,
          verificationState: "needs_human",
          autoInjectEligible: false,
          updatedAt: now,
        };
      } else if (input.outcome === "supported" || input.outcome === "confirmed") {
        next = {
          ...current,
          confidence: clamp(current.confidence + 0.05, 0, 1),
          lastConfirmedAt: now,
          updatedAt: now,
        };
      } else if (input.outcome === "partially_supported") {
        next = {
          ...current,
          confidence: clamp(current.confidence - 0.05, 0, 1),
          updatedAt: now,
        };
      }
      if (next !== current) this.updateNodeRow(this.recomputeEligibility(next));
      this.recordEvent({ type: "system", id: "audit" }, "audit", current.id, {
        trigger: input.trigger,
        outcome: input.outcome,
        version: input.version || current.version,
      });
    });
  }

  recordFeedback(input: {
    nodeID: string;
    version?: number;
    source: Record<string, unknown>;
    outcome: string;
    details?: Record<string, unknown>;
  }): void {
    const row = this.getRow(input.nodeID);
    if (!row) return;
    const node = this.rowToNode(row);
    this.db
      .prepare(
        `INSERT INTO feedback(node_id, node_version, source_json, outcome, details_json, created_at)
         VALUES(?, ?, ?, ?, ?, ?)`,
      )
      .run(
        node.id,
        input.version ?? node.version,
        JSON.stringify(input.source),
        input.outcome,
        JSON.stringify(input.details ?? {}),
        this.now(),
      );
  }

  recordInjections(
    sessionID: string,
    messageID: string | undefined,
    cards: MemoryCard[],
    source: "auto" | "tool",
  ): void {
    if (!cards.length) return;
    transaction(this.db, () => {
      const now = this.now();
      const statement = this.db.prepare(
        `INSERT INTO injections(session_id, message_id, node_id, rank, tokens, source, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)`,
      );
      cards.forEach((card, index) => {
        statement.run(
          sessionID,
          messageID ?? null,
          card.id,
          index + 1,
          estimateTokens(formatCardText(card)),
          source,
          now,
        );
      });
    });
  }

  exportBundle(): ExportBundle {
    const nodes = this.db
      .prepare("SELECT * FROM nodes ORDER BY id")
      .all()
      .map((row) => this.rowToNode(row));
    return {
      schemaVersion: 1,
      exportedAt: this.now(),
      projectRoot: this.projectRoot,
      nodes,
      versions: this.db.prepare("SELECT * FROM node_versions ORDER BY node_id, version").all(),
      edges: this.db.prepare("SELECT * FROM edges ORDER BY from_id, to_id, type").all(),
      sources: this.db.prepare("SELECT * FROM sources ORDER BY type, locator").all(),
      citations: this.db.prepare("SELECT * FROM citations ORDER BY node_id, node_version, id").all(),
    };
  }

  seed(proposals: MemoryProposal[], author: Author = { type: "system", id: "seed" }): RememberResult[] {
    return proposals.map((proposal) => this.remember(proposal, { author }));
  }
}

function canonicalPair(nodeA: string, nodeB: string): [string, string] {
  return nodeA.localeCompare(nodeB) <= 0 ? [nodeA, nodeB] : [nodeB, nodeA];
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function tokenize(value: string): string[] {
  return (value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []).filter((token) => token.length > 1);
}

const QUERY_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "for",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "with",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "this",
  "that",
  "these",
  "those",
  "how",
  "what",
  "why",
  "when",
  "where",
  "which",
  "who",
  "it",
  "its",
  "as",
  "from",
  "do",
  "does",
  "did",
  "can",
  "could",
  "should",
  "would",
  "will",
  "not",
  "no",
]);

function queryTokensFor(value: string): string[] {
  return tokenize(value).filter((token) => !QUERY_STOPWORDS.has(token));
}

function hasTokenOverlap(node: MemoryNode, tokens: string[]): boolean {
  if (!tokens.length) return false;
  const haystack = new Set(tokenize(`${node.title} ${node.body} ${node.tags.join(" ")}`));
  return tokens.some((token) => haystack.has(token));
}

function buildFtsQuery(value: string): string | undefined {
  const tokens = queryTokensFor(value);
  if (!tokens.length) return undefined;
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}

function groupCount(db: SqliteDatabase, column: string): Record<string, number> {
  const rows = db.prepare(`SELECT ${column} AS key, COUNT(*) AS count FROM nodes GROUP BY ${column}`).all();
  return Object.fromEntries(rows.map((row) => [String(row.key), Number(row.count)]));
}

export type { SqlValue };
