import { Plugin } from "@opencode/plugin";
import { MemoryStore } from "../core/store.ts";
import { defaultDbPath, ensureParent } from "../core/paths.ts";
import { parseInjectionPolicy, type InjectionPolicy } from "../core/policy.ts";
import { CompositeVerifier, DeterministicVerifier, type Verifier } from "../core/verification.ts";
import { ModelVerifier } from "./verifier.ts";

type PluginDefinition = Parameters<typeof Plugin.define>[0];
export type PluginContext = Parameters<PluginDefinition["setup"]>[0];

export interface Runtime {
  ctx: PluginContext;
  store: MemoryStore;
  projectRoot: string;
  autoRecall: boolean;
  autoInject: boolean;
  requireWritePermission: boolean;
  injectBudgetTokens: number;
  injectMaxCards: number;
  policy: InjectionPolicy;
  verifier: Verifier;
  verificationModel?: string;
  verificationSemantic: boolean;
  verificationMaxPerRun: number;
  auditMaxPerRun: number;
  auditUniformRate: number;
  auditRiskRate: number;
}

function numberOption(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export async function createRuntime(ctx: PluginContext): Promise<Runtime> {
  const options = (ctx.options ?? {}) as Record<string, unknown>;
  const projectRoot = String(
    options.projectRoot ?? ctx.location.project?.canonical ?? ctx.location.directory,
  );
  const dbPath = String(options.dbPath ?? defaultDbPath(projectRoot));
  ensureParent(dbPath);
  const policy = parseInjectionPolicy(options.policy);
  const store = await MemoryStore.open({ dbPath, projectRoot, policy });
  const verificationOptions = (options.verification ?? {}) as Record<string, unknown>;
  const auditOptions = (options.audit ?? {}) as Record<string, unknown>;
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
  return {
    ctx,
    store,
    projectRoot,
    autoRecall: options.autoRecall !== false,
    autoInject: options.autoInject !== false,
    requireWritePermission: options.requireWritePermission === true,
    injectBudgetTokens: numberOption(options.injectBudgetTokens, 700),
    injectMaxCards: numberOption(options.injectMaxCards, 5),
    policy,
    verifier,
    ...(verificationModel ? { verificationModel } : {}),
    verificationSemantic: semanticEnabled,
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
  };
}
