import { Plugin } from "@opencode/plugin";
import { MemoryStore } from "../core/store.ts";
import { defaultDbPath, ensureParent } from "../core/paths.ts";
import { parseInjectionPolicy, type InjectionPolicy } from "../core/policy.ts";

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
  };
}
