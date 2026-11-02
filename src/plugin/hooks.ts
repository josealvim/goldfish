import path from "node:path";
import type { Registration } from "@opencode/plugin/promise/registration";
import type { SessionContext, SessionPrompt } from "@opencode/plugin/promise/session";
import { formatAutoRecallBlock } from "../core/format.ts";
import type { PluginContext, Runtime } from "./runtime.ts";

interface InstructionsEntryApi {
  put(input: { sessionID: string; key: string; value: string }): Promise<void>;
  remove(input: { sessionID: string; key: string }): Promise<void>;
}

interface InstructionsApi {
  instructions?: { entry: InstructionsEntryApi };
}

interface AutoRecallState {
  messageID: string;
  entryKey: string;
  block: string;
  entrySet: boolean;
}

const SHORT_ACKNOWLEDGEMENTS =
  /^(yes|no|ok|okay|continue|go on|proceed|thanks|thank you|sure|yep|nope)\.?$/i;
const PATH_TOKEN =
  /(?:^|\s)([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|md|mdx|json|jsonc|sql|py|go|rs|java|kt|rb|php|cs|cpp|c|h|hpp|yaml|yml|toml|sh|css|scss|html))(?=[\s,;:)]|$)/g;

function instructionsFor(ctx: PluginContext): InstructionsEntryApi | undefined {
  return (ctx.session as unknown as InstructionsApi).instructions?.entry;
}

async function removeEntry(ctx: PluginContext, sessionID: string, key: string): Promise<void> {
  try {
    await instructionsFor(ctx)?.remove({ sessionID, key });
  } catch {
    // Session instruction entries are an enhancement; a missing or removed
    // entry must never break prompt admission or teardown.
  }
}

function collectScopes(text: string, files: SessionPrompt["prompt"]["files"], projectRoot: string): string[] {
  const scopes = new Set<string>();
  for (const file of files ?? []) {
    try {
      const url = new URL(file.uri);
      if (url.protocol !== "file:") continue;
      const absolute = decodeURIComponent(url.pathname);
      const relative = path.relative(projectRoot, absolute);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        scopes.add(relative.split(path.sep).join("/"));
      }
    } catch {
      // Ignore malformed attachment URIs.
    }
  }
  for (const match of text.matchAll(PATH_TOKEN)) {
    const candidate = match[1]?.replace(/^\.\//, "");
    if (candidate) scopes.add(candidate);
    if (scopes.size >= 8) break;
  }
  return [...scopes].slice(0, 8);
}

function shouldAutoRecall(text: string, scopes: string[]): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/")) return false;
  if (SHORT_ACKNOWLEDGEMENTS.test(trimmed)) return false;
  if (/\bmemory_(recall|remember|get|neighbors)\b/i.test(trimmed)) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 4 && scopes.length === 0) return false;
  if (trimmed.length < 12 && scopes.length === 0) return false;
  return true;
}

export async function registerHooks(ctx: PluginContext, runtime: Runtime): Promise<() => Promise<void>> {
  const states = new Map<string, AutoRecallState>();

  const promptRegistration = await ctx.session.hook("prompt", async (event: SessionPrompt) => {
    if (!runtime.autoRecall || !runtime.autoInject) return;
    const sessionID = String(event.sessionID);
    const messageID = String(event.messageID);
    const previous = states.get(sessionID);
    if (previous && previous.messageID !== messageID) {
      await removeEntry(ctx, sessionID, previous.entryKey);
      states.delete(sessionID);
    }

    const scopes = collectScopes(event.prompt.text, event.prompt.files, runtime.projectRoot);
    if (!shouldAutoRecall(event.prompt.text, scopes)) return;

    let result;
    try {
      result = runtime.store.recall({
        query: event.prompt.text.slice(0, 1500),
        scope: scopes,
        limit: runtime.injectMaxCards,
        budgetTokens: runtime.injectBudgetTokens,
        autoInjectOnly: true,
        includeInferred: false,
        includeDisputed: false,
        includeStale: false,
      });
    } catch (error) {
      console.error("project-memory: automatic recall failed", error);
      return;
    }

    if (!result.cards.length) return;
    const block = formatAutoRecallBlock(result);
    const entryKey = `project-memory/${messageID}`;
    let entrySet = false;
    try {
      const instructions = instructionsFor(ctx);
      if (instructions) {
        await instructions.put({ sessionID, key: entryKey, value: block });
        entrySet = true;
      }
    } catch (error) {
      console.error("project-memory: could not persist session instruction entry", error);
    }

    states.set(sessionID, {
      messageID,
      entryKey,
      block,
      entrySet,
    });

    try {
      runtime.store.recordInjections(sessionID, messageID, result.cards, "auto");
    } catch (error) {
      console.error("project-memory: failed to record automatic injection", error);
    }
  });

  const contextRegistration = await ctx.session.hook("context", async (event: SessionContext) => {
    if (!runtime.autoInject) return;
    const state = states.get(String(event.sessionID));
    if (!state?.block || state.entrySet) return;
    // Fallback for runtimes where session instruction entries are unavailable:
    // keep the recalled block in the outgoing system context for the turn.
    event.system.push({
      type: "text",
      text: state.block,
      metadata: { source: "project-memory" },
    });
  });

  return async () => {
    await promptRegistration.dispose();
    await contextRegistration.dispose();
    for (const [sessionID, state] of states) {
      await removeEntry(ctx, sessionID, state.entryKey);
    }
    states.clear();
  };
}

export type { Registration };
