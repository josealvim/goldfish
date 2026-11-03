import { Plugin } from "@opencode/plugin";
import type { MemoryStore } from "../core/store.ts";
import { openProjectStore, type ProjectStoreKind } from "../core/project-store.ts";
import type { ProjectIdentityKind } from "../core/project-identity.ts";
import { parseInjectionPolicy, type InjectionPolicy } from "../core/policy.ts";
import type { ConflictVerifier } from "../core/conflicts.ts";
import { CompositeVerifier, DeterministicVerifier, type Verifier } from "../core/verification.ts";
import { ModelConflictVerifier, ModelVerifier } from "./verifier.ts";

type PluginDefinition = Parameters<typeof Plugin.define>[0];
export type PluginContext = Parameters<PluginDefinition["setup"]>[0];

export interface Runtime {
  ctx: PluginContext;
  store: MemoryStore;
  projectRoot: string;
  projectKey: string;
  projectId?: string;
  identityKind: ProjectIdentityKind;
  dbPath: string;
  storeKind: ProjectStoreKind;
  pendingStabilization: boolean;
  pendingAdoption: boolean;
  adoptionNote?: string;
  autoRecall: boolean;
  autoInject: boolean;
  requireWritePermission: boolean;
  injectBudgetTokens: number;
  injectMaxCards: number;
  policy: InjectionPolicy;
  verifier: Verifier;
  conflictVerifier?: ConflictVerifier;
  verificationModel?: string;
  verificationSemantic: boolean;
  verificationReadSources: boolean;
  verificationWindowLines: number;
  verificationMaxSourceBytes: number;
  verificationMaxPacketSourceBytes: number;
  verificationMaxPerRun: number;
  auditMaxPerRun: number;
  auditUniformRate: number;
  auditRiskRate: number;
  conflictMaxPerRun: number;
  conflictCandidatesPerClaim: number;
}

function numberOption(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export async function createRuntime(ctx: PluginContext): Promise<Runtime> {
  const options = (ctx.options ?? {}) as Record<string, unknown>;
  const projectRoot = String(
    options.projectRoot ?? ctx.location.project?.canonical ?? ctx.location.directory,
  );
  const policy = parseInjectionPolicy(options.policy);
  const opened = await openProjectStore({
    projectRoot,
    ...(typeof options.dbPath === "string" ? { dbPath: options.dbPath } : {}),
    createIdentity: true,
    adopt: true,
    policy,
  });
  const { store, resolution } = opened;
  const verificationOptions = (options.verification ?? {}) as Record<string, unknown>;
  const auditOptions = (options.audit ?? {}) as Record<string, unknown>;
  const conflictOptions = (options.conflict ?? {}) as Record<string, unknown>;
  const verificationModel =
    typeof options.verificationModel === "string"
      ? options.verificationModel
      : typeof verificationOptions.model === "string"
        ? verificationOptions.model
        : undefined;
  const semanticEnabled =
    options.verificationSemantic !== false && verificationOptions.semantic !== false;
  const verifier: Verifier = semanticEnabled
    ? new CompositeVerifier(new DeterministicVerifier(), new ModelVerifier(ctx, verificationModel))
    : new DeterministicVerifier();
  const conflictVerifier = semanticEnabled
    ? new ModelConflictVerifier(ctx, verificationModel)
    : undefined;
  const readSources =
    options.verificationReadSources !== false && verificationOptions.readSources !== false;
  return {
    ctx,
    store,
    projectRoot: resolution.projectRoot,
    projectKey: resolution.identity.projectKey,
    ...(resolution.identity.projectId ? { projectId: resolution.identity.projectId } : {}),
    identityKind: resolution.identity.kind,
    dbPath: resolution.dbPath,
    storeKind: resolution.storeKind,
    pendingStabilization: resolution.pendingStabilization,
    pendingAdoption: resolution.pendingAdoption,
    ...(resolution.note && (resolution.storeKind === "stable" || resolution.pendingAdoption)
      ? { adoptionNote: resolution.note }
      : {}),
    autoRecall: options.autoRecall !== false,
    autoInject: options.autoInject !== false,
    requireWritePermission: options.requireWritePermission === true,
    injectBudgetTokens: numberOption(options.injectBudgetTokens, 700),
    injectMaxCards: numberOption(options.injectMaxCards, 5),
    policy,
    verifier,
    ...(conflictVerifier ? { conflictVerifier } : {}),
    ...(verificationModel ? { verificationModel } : {}),
    verificationSemantic: semanticEnabled,
    verificationReadSources: readSources,
    verificationWindowLines: Math.max(
      5,
      Math.min(
        200,
        numberOption(
          options.verificationWindowLines ?? verificationOptions.windowLines,
          40,
        ),
      ),
    ),
    verificationMaxSourceBytes: Math.max(
      500,
      Math.min(
        20_000,
        numberOption(
          options.verificationMaxSourceBytes ?? verificationOptions.maxSourceBytes,
          4_000,
        ),
      ),
    ),
    verificationMaxPacketSourceBytes: Math.max(
      1_000,
      Math.min(
        60_000,
        numberOption(
          options.verificationMaxPacketSourceBytes ??
            verificationOptions.maxPacketSourceBytes,
          12_000,
        ),
      ),
    ),
    verificationMaxPerRun: numberOption(
      options.verificationMaxPerRun ?? verificationOptions.maxPerRun,
      5,
    ),
    auditMaxPerRun: numberOption(options.auditMaxPerRun ?? auditOptions.maxPerRun, 10),
    auditUniformRate: Math.max(
      0,
      Math.min(1, numberOption(options.auditUniformRate ?? auditOptions.uniformRate, 0.03)),
    ),
    auditRiskRate: Math.max(
      0,
      Math.min(1, numberOption(options.auditRiskRate ?? auditOptions.riskRate, 0.07)),
    ),
    conflictMaxPerRun: Math.max(
      1,
      Math.min(
        10,
        numberOption(
          options.conflictMaxPerRun ?? conflictOptions.maxPerRun,
          3,
        ),
      ),
    ),
    conflictCandidatesPerClaim: Math.max(
      1,
      Math.min(
        8,
        numberOption(
          options.conflictCandidatesPerClaim ?? conflictOptions.candidatesPerClaim,
          3,
        ),
      ),
    ),
  };
}
