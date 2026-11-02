import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  Basis,
  CitationInput,
  ConflictFinding,
  EdgeType,
  MemoryNode,
  NodeKind,
} from "./types.ts";
import { MemoryStore } from "./store.ts";
import {
  buildVerificationPacket,
  type VerificationPacket,
  type VerificationPacketOptions,
  type VerificationVerdict,
  type VerificationVerdictKind,
  type Verifier,
} from "./verification.ts";
import type { ConflictVerifier } from "./conflicts.ts";

export interface EvalNodeSpec {
  kind: NodeKind;
  title: string;
  body: string;
  basis?: Basis;
  confidence?: number;
  scope?: string[];
  tags?: string[];
  citations?: CitationInput[];
  links?: Array<{ to: string; type: EdgeType }>;
  metadata?: Record<string, unknown>;
}

export interface SupportEvalCase {
  name: string;
  files?: Record<string, string>;
  mutateFiles?: Record<string, string>;
  deleteFiles?: string[];
  nodes: EvalNodeSpec[];
  target: string;
  expect: {
    verdict: VerificationVerdictKind;
    evidence?: string[];
  };
}

export interface ConflictEvalCase {
  name: string;
  files?: Record<string, string>;
  mutateFiles?: Record<string, string>;
  deleteFiles?: string[];
  nodes: EvalNodeSpec[];
  target: string;
  expect: {
    conflicts: string[];
    notConflicts?: string[];
    evidence?: string[];
  };
}

export interface SupportEvalCaseResult {
  name: string;
  passed: boolean;
  expected: VerificationVerdictKind;
  actual?: VerificationVerdictKind;
  evidence: VerificationVerdict["evidence"];
  evidenceGrounded: boolean;
  evidenceMatched: boolean;
  error?: string;
}

export interface SupportEvalMetrics {
  total: number;
  passed: number;
  accuracy: number;
  supportedPrecision: number;
  supportedRecall: number;
  falseSupport: number;
  falseConflict: number;
  evidenceGrounded: number;
  evidenceMatched: number;
}

export interface SupportEvalResult {
  results: SupportEvalCaseResult[];
  metrics: SupportEvalMetrics;
}

export interface ConflictEvalCaseResult {
  name: string;
  passed: boolean;
  expectedConflicts: string[];
  actualConflicts: string[];
  expectedNotConflicts: string[];
  falsePositives: string[];
  candidateRecall: boolean;
  evidence: ConflictFinding["evidence"];
  evidenceGrounded: boolean;
  evidenceMatched: boolean;
  error?: string;
}

export interface ConflictEvalMetrics {
  total: number;
  passed: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  candidateRecall: number;
  evidenceGrounded: number;
  evidenceMatched: number;
}

export interface ConflictEvalResult {
  results: ConflictEvalCaseResult[];
  metrics: ConflictEvalMetrics;
}

export interface EvalRunOptions extends VerificationPacketOptions {
  candidatesPerClaim?: number;
}

function readJsonLines<T>(file: string): T[] {
  const text = readFileSync(file, "utf8");
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        throw new Error(`Invalid JSON in ${file} on line ${index + 1}.`);
      }
    });
}

export function loadSupportCases(file: string): SupportEvalCase[] {
  return readJsonLines<SupportEvalCase>(file);
}

export function loadConflictCases(file: string): ConflictEvalCase[] {
  return readJsonLines<ConflictEvalCase>(file);
}

function writeFixtureFiles(root: string, files: Record<string, string> | undefined): void {
  for (const [file, content] of Object.entries(files ?? {})) {
    const absolute = path.resolve(root, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
}

function seedNodes(store: MemoryStore, specs: EvalNodeSpec[]): Map<string, MemoryNode> {
  const byTitle = new Map<string, MemoryNode>();
  for (const spec of specs) {
    const links = (spec.links ?? []).map((link) => {
      const target = byTitle.get(link.to);
      if (!target) {
        throw new Error(
          `Eval node "${spec.title}" links to "${link.to}" before it is created. Order nodes by dependency.`,
        );
      }
      return { to: target.id, type: link.type };
    });
    const result = store.remember(
      {
        kind: spec.kind,
        title: spec.title,
        body: spec.body,
        ...(spec.basis ? { basis: spec.basis } : {}),
        ...(spec.confidence !== undefined ? { confidence: spec.confidence } : {}),
        ...(spec.scope ? { scope: spec.scope } : {}),
        ...(spec.tags ? { tags: spec.tags } : {}),
        ...(spec.citations ? { citations: spec.citations } : {}),
        ...(links.length ? { links } : {}),
        ...(spec.metadata ? { metadata: spec.metadata } : {}),
      },
      { author: { type: "system", id: "eval" } },
    );
    if (!result.node) {
      throw new Error(
        `Eval node "${spec.title}" was rejected: ${(result.reasons ?? []).join("; ")}`,
      );
    }
    byTitle.set(spec.title, result.node);
  }
  return byTitle;
}

async function withFixtureStore<T>(
  files: Record<string, string> | undefined,
  callback: (store: MemoryStore, root: string) => Promise<T> | T,
): Promise<T> {
  const root = mkdtempSync(path.join(tmpdir(), "goldfish-eval-"));
  writeFixtureFiles(root, files);
  const store = await MemoryStore.open({ dbPath: ":memory:", projectRoot: root });
  try {
    return await callback(store, root);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function applyCaseMutations(
  root: string,
  files: Record<string, string> | undefined,
  deleteFiles: string[] | undefined,
): void {
  writeFixtureFiles(root, files);
  for (const file of deleteFiles ?? []) {
    rmSync(path.resolve(root, file), { force: true });
  }
}

function packetOptions(options: EvalRunOptions): VerificationPacketOptions {
  return {
    readSources: options.readSources,
    windowLines: options.windowLines,
    maxSourceBytes: options.maxSourceBytes,
    maxPacketSourceBytes: options.maxPacketSourceBytes,
    maxCitations: options.maxCitations,
    maxPremises: options.maxPremises,
    maxConflicts: options.maxConflicts,
    maxContext: options.maxContext,
    maxHistory: options.maxHistory,
  };
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeLocator(locator: string): string {
  return locator.replace(/^file:/, "").replaceAll("\\", "/").toLowerCase();
}

function sourceTexts(packets: VerificationPacket[]): string[] {
  const texts: string[] = [];
  for (const packet of packets) {
    for (const check of packet.citationChecks) {
      if (check.citation.excerpt) texts.push(check.citation.excerpt);
      if (check.snapshot?.content) texts.push(check.snapshot.content);
    }
  }
  return texts.map(normalize);
}

function evidenceGrounded(
  evidence: Array<{ locator: string; quote: string }> | undefined,
  packets: VerificationPacket[],
): boolean {
  if (!evidence?.length) return false;
  const texts = sourceTexts(packets);
  return evidence.every((item) => {
    const locator = normalizeLocator(item.locator);
    const quote = normalize(item.quote);
    if (!quote) return false;
    return texts.some((text) => {
      if (!text.includes(quote)) return false;
      return !locator || packets.some((packet) =>
        packet.citationChecks.some(
          (check) => normalizeLocator(check.citation.locator) === locator,
        ),
      );
    });
  });
}

function evidenceMatched(
  expected: string[] | undefined,
  evidence: Array<{ quote: string; why?: string }> | undefined,
): boolean {
  if (!expected?.length) return true;
  if (!evidence?.length) return false;
  const haystack = normalize(
    evidence.map((item) => `${item.quote} ${item.why ?? ""}`).join(" "),
  );
  return expected.every((anchor) => haystack.includes(normalize(anchor)));
}

export async function runSupportEval(
  cases: SupportEvalCase[],
  verifier: Verifier,
  options: EvalRunOptions = {},
): Promise<SupportEvalResult> {
  const results: SupportEvalCaseResult[] = [];
  let truePositive = 0;
  let predictedPositive = 0;
  let expectedPositive = 0;
  let falseSupport = 0;
  let falseConflict = 0;

  for (const item of cases) {
    let result: SupportEvalCaseResult;
    try {
      result = await withFixtureStore(item.files, async (store, root) => {
        const byTitle = seedNodes(store, item.nodes);
        const target = byTitle.get(item.target);
        if (!target) throw new Error(`Eval target "${item.target}" was not created.`);
        applyCaseMutations(root, item.mutateFiles, item.deleteFiles);
        const packet = buildVerificationPacket(store, target.id, packetOptions(options));
        if (!packet) throw new Error(`No verification packet for "${item.target}".`);
        const verdict = await verifier.verify(packet);
        const actual = verdict.verdict;
        const requiresEvidence =
          Boolean(item.expect.evidence?.length) ||
          actual === "supported" ||
          actual === "partially_supported" ||
          actual === "contradicted";
        const grounded = requiresEvidence
          ? evidenceGrounded(verdict.evidence, [packet])
          : true;
        const matched = evidenceMatched(item.expect.evidence, verdict.evidence);
        return {
          name: item.name,
          passed: actual === item.expect.verdict,
          expected: item.expect.verdict,
          actual,
          evidence: verdict.evidence,
          evidenceGrounded: grounded,
          evidenceMatched: matched,
        };
      });
    } catch (error) {
      result = {
        name: item.name,
        passed: false,
        expected: item.expect.verdict,
        evidence: [],
        evidenceGrounded: false,
        evidenceMatched: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (result.actual === "supported") predictedPositive++;
    if (item.expect.verdict === "supported") expectedPositive++;
    if (result.actual === "supported" && item.expect.verdict === "supported") truePositive++;
    if (result.actual === "supported" && item.expect.verdict !== "supported") falseSupport++;
    if (result.actual === "contradicted" && item.expect.verdict !== "contradicted") falseConflict++;
    results.push(result);
  }

  const total = results.length;
  const passed = results.filter((result) => result.passed).length;
  return {
    results,
    metrics: {
      total,
      passed,
      accuracy: total ? passed / total : 0,
      supportedPrecision: predictedPositive ? truePositive / predictedPositive : 0,
      supportedRecall: expectedPositive ? truePositive / expectedPositive : 0,
      falseSupport,
      falseConflict,
      evidenceGrounded: results.filter((result) => result.evidenceGrounded).length,
      evidenceMatched: results.filter((result) => result.evidenceMatched).length,
    },
  };
}

export async function runConflictEval(
  cases: ConflictEvalCase[],
  verifier: ConflictVerifier,
  options: EvalRunOptions = {},
): Promise<ConflictEvalResult> {
  const results: ConflictEvalCaseResult[] = [];
  let truePositives = 0;
  let falsePositivesTotal = 0;
  let falseNegatives = 0;
  let candidateHits = 0;

  for (const item of cases) {
    let result: ConflictEvalCaseResult;
    try {
      result = await withFixtureStore(item.files, async (store, root) => {
        const byTitle = seedNodes(store, item.nodes);
        const target = byTitle.get(item.target);
        if (!target) throw new Error(`Eval target "${item.target}" was not created.`);
        applyCaseMutations(root, item.mutateFiles, item.deleteFiles);
        const targetPacket = buildVerificationPacket(store, target.id, {
          ...packetOptions(options),
          maxConflicts: 0,
          maxContext: 0,
          maxHistory: 0,
        });
        if (!targetPacket) throw new Error(`No verification packet for "${item.target}".`);
        const candidateNodes = store.relatedClaims(target.id, {
          limit: options.candidatesPerClaim ?? 3,
        });
        const candidatePackets = candidateNodes.flatMap((node) => {
          const packet = buildVerificationPacket(store, node.id, {
            ...packetOptions(options),
            maxCitations: Math.min(options.maxCitations ?? 3, 3),
            maxPremises: Math.min(options.maxPremises ?? 2, 2),
            maxConflicts: 0,
            maxContext: 0,
            maxHistory: 0,
          });
          return packet ? [packet] : [];
        });
        const candidateTitles = new Set(candidatePackets.map((packet) => packet.node.title));
        const candidateRecall = item.expect.conflicts.every((title) =>
          candidateTitles.has(title),
        );
        const verdict = await verifier.find(targetPacket, candidatePackets);
        if (verdict.error) throw new Error(verdict.error);
        const titlesByID = new Map(
          candidatePackets.map((packet) => [packet.node.id, packet.node.title]),
        );
        const actualConflicts = verdict.findings
          .map((finding) => titlesByID.get(finding.candidateID))
          .filter((title): title is string => Boolean(title));
        const expected = new Set(item.expect.conflicts);
        const actual = new Set(actualConflicts);
        const notConflicts = item.expect.notConflicts ?? [];
        const falsePositives = [...actual].filter(
          (title) => !expected.has(title) || notConflicts.includes(title),
        );
        const passed =
          item.expect.conflicts.every((title) => actual.has(title)) &&
          falsePositives.length === 0;
        const evidence = verdict.findings.flatMap((finding) => finding.evidence);
        const requiresEvidence =
          actualConflicts.length > 0 || Boolean(item.expect.evidence?.length);
        return {
          name: item.name,
          passed,
          expectedConflicts: item.expect.conflicts,
          actualConflicts,
          expectedNotConflicts: notConflicts,
          falsePositives,
          candidateRecall,
          evidence,
          evidenceGrounded: requiresEvidence
            ? evidenceGrounded(evidence, [targetPacket, ...candidatePackets])
            : true,
          evidenceMatched: evidenceMatched(item.expect.evidence, evidence),
        };
      });
    } catch (error) {
      result = {
        name: item.name,
        passed: false,
        expectedConflicts: item.expect.conflicts,
        actualConflicts: [],
        expectedNotConflicts: item.expect.notConflicts ?? [],
        falsePositives: [],
        candidateRecall: false,
        evidence: [],
        evidenceGrounded: false,
        evidenceMatched: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const expected = new Set(item.expect.conflicts);
    const actual = new Set(result.actualConflicts);
    truePositives += [...actual].filter((title) => expected.has(title)).length;
    falsePositivesTotal += result.falsePositives.length;
    falseNegatives += [...expected].filter((title) => !actual.has(title)).length;
    if (result.candidateRecall) candidateHits++;
    results.push(result);
  }

  const precision =
    truePositives + falsePositivesTotal
      ? truePositives / (truePositives + falsePositivesTotal)
      : 0;
  const recall =
    truePositives + falseNegatives
      ? truePositives / (truePositives + falseNegatives)
      : 0;
  const total = results.length;
  const passed = results.filter((result) => result.passed).length;
  return {
    results,
    metrics: {
      total,
      passed,
      truePositives,
      falsePositives: falsePositivesTotal,
      falseNegatives,
      precision,
      recall,
      f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
      candidateRecall: total ? candidateHits / total : 0,
      evidenceGrounded: results.filter((result) => result.evidenceGrounded).length,
      evidenceMatched: results.filter((result) => result.evidenceMatched).length,
    },
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function formatSupportEval(result: SupportEvalResult): string {
  const lines = [
    `# Support evaluation (${result.metrics.total} cases)`,
    `Verdict accuracy: ${percent(result.metrics.accuracy)} (${result.metrics.passed}/${result.metrics.total})`,
    `Supported precision: ${percent(result.metrics.supportedPrecision)}`,
    `Supported recall: ${percent(result.metrics.supportedRecall)}`,
    `False support: ${result.metrics.falseSupport}`,
    `False conflict: ${result.metrics.falseConflict}`,
    `Evidence grounded: ${result.metrics.evidenceGrounded}/${result.metrics.total}`,
    `Expected evidence matched: ${result.metrics.evidenceMatched}/${result.metrics.total}`,
    "",
  ];
  for (const item of result.results) {
    const status = item.passed ? "PASS" : "FAIL";
    lines.push(
      `${status} ${item.name}: expected ${item.expected}, got ${item.actual ?? "error"}` +
        (item.evidenceGrounded ? " · evidence grounded" : " · no grounded evidence"),
    );
    if (item.error) lines.push(`  Error: ${item.error}`);
    for (const evidence of item.evidence.slice(0, 3)) {
      lines.push(
        `  Evidence: ${evidence.locator} — "${evidence.quote.slice(0, 160)}"` +
          (evidence.why ? ` (${evidence.why})` : ""),
      );
    }
  }
  return lines.join("\n");
}

export function formatConflictEval(result: ConflictEvalResult): string {
  const lines = [
    `# Conflict evaluation (${result.metrics.total} cases)`,
    `Passed: ${result.metrics.passed}/${result.metrics.total}`,
    `Pair precision: ${percent(result.metrics.precision)}`,
    `Pair recall: ${percent(result.metrics.recall)}`,
    `Pair F1: ${percent(result.metrics.f1)}`,
    `False positives: ${result.metrics.falsePositives}`,
    `False negatives: ${result.metrics.falseNegatives}`,
    `Candidate recall: ${percent(result.metrics.candidateRecall)}`,
    `Evidence grounded: ${result.metrics.evidenceGrounded}/${result.metrics.total}`,
    `Expected evidence matched: ${result.metrics.evidenceMatched}/${result.metrics.total}`,
    "",
  ];
  for (const item of result.results) {
    const status = item.passed ? "PASS" : "FAIL";
    lines.push(
      `${status} ${item.name}: expected [${item.expectedConflicts.join(", ")}], ` +
        `got [${item.actualConflicts.join(", ")}]` +
        (item.candidateRecall ? "" : " · expected candidate was not retrieved"),
    );
    if (item.error) lines.push(`  Error: ${item.error}`);
    for (const evidence of item.evidence.slice(0, 3)) {
      lines.push(
        `  Evidence: ${evidence.locator} — "${evidence.quote.slice(0, 160)}"` +
          (evidence.why ? ` (${evidence.why})` : ""),
      );
    }
  }
  return lines.join("\n");
}
