import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntime, type PluginContext, type Runtime } from "../src/plugin/runtime.ts";
import { registerTools } from "../src/plugin/tools.ts";
import { registerHooks } from "../src/plugin/hooks.ts";
import { registerSkill, readSkillContent } from "../src/plugin/skill.ts";
import type { SessionContext, SessionPrompt } from "@opencode/plugin/promise/session";
import type { ToolContext } from "@opencode/plugin/promise/tool";

interface Fake {
  ctx: PluginContext;
  tools: Map<string, any>;
  promptHooks: Array<(event: SessionPrompt) => Promise<void> | void>;
  contextHooks: Array<(event: SessionContext) => Promise<void> | void>;
  entries: Map<string, string>;
  removed: string[];
  permissions: any[];
  skills: any[];
  disposals: number;
}

function makeFake(options: {
  root: string;
  dbPath: string;
  withInstructions?: boolean;
  requireWritePermission?: boolean;
}): Fake {
  const tools = new Map<string, any>();
  const promptHooks: Fake["promptHooks"] = [];
  const contextHooks: Fake["contextHooks"] = [];
  const entries = new Map<string, string>();
  const removed: string[] = [];
  const permissions: any[] = [];
  const skills: any[] = [];
  let disposals = 0;
  const registration = {
    dispose: async () => {
      disposals++;
    },
  };

  const session: Record<string, unknown> = {
    hook: async (name: string, callback: (event: never) => void) => {
      if (name === "prompt") promptHooks.push(callback as never);
      else contextHooks.push(callback as never);
      return registration;
    },
  };
  if (options.withInstructions !== false) {
    session.instructions = {
      entry: {
        put: async (input: { key: string; value: string }) => {
          entries.set(input.key, input.value);
        },
        remove: async (input: { key: string }) => {
          entries.delete(input.key);
          removed.push(input.key);
        },
      },
    };
  }

  const ctx = {
    options: {
      dbPath: options.dbPath,
      projectRoot: options.root,
      requireWritePermission: options.requireWritePermission ?? false,
      injectBudgetTokens: 700,
      injectMaxCards: 5,
    },
    location: {
      directory: options.root,
      project: { id: "test", directory: options.root, canonical: options.root },
    },
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          namespace: () => {},
          add: (tool: { name: string }) => tools.set(tool.name, tool),
        });
        return registration;
      },
    },
    session,
    permission: {
      assert: async (input: unknown) => {
        permissions.push(input);
      },
    },
    skill: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({ add: (skill: unknown) => skills.push(skill) });
        return registration;
      },
    },
  } as unknown as PluginContext;

  return {
    ctx,
    tools,
    promptHooks,
    contextHooks,
    entries,
    removed,
    permissions,
    skills,
    get disposals() {
      return disposals;
    },
  };
}

async function withPlugin(
  callback: (fake: Fake, runtime: Runtime) => Promise<void> | void,
  options: { withInstructions?: boolean; requireWritePermission?: boolean } = {},
): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "goldfish-plugin-"));
  mkdirSync(path.join(root, "docs"), { recursive: true });
  writeFileSync(path.join(root, "docs", "decisions.md"), "# Decisions\n\nInjection policy.\n");
  const fake = makeFake({ root, dbPath: path.join(root, "memory.sqlite"), ...options });
  const runtime = await createRuntime(fake.ctx);
  try {
    await callback(fake, runtime);
  } finally {
    runtime.store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const toolContext = {
  sessionID: "ses_test",
  agent: "build",
  messageID: "msg_test",
  id: "call_test",
  signal: new AbortController().signal,
  progress: async () => {},
} as unknown as ToolContext;

function seed(runtime: Runtime, title = "Injection policy") {
  return runtime.store.remember(
    {
      kind: "decision",
      title,
      body: "Inferred claims require confirmation before automatic injection.",
      citations: [{ type: "file", locator: "docs/decisions.md" }],
    },
    { author: { type: "system", id: "test" } },
  );
}

test("registers agent tools and executes recall/get", async () => {
  await withPlugin(async (fake, runtime) => {
    const created = seed(runtime);
    await registerTools(fake.ctx, runtime);
    assert.deepEqual([...fake.tools.keys()].sort(), ["get", "neighbors", "recall", "remember"]);

    const recall = fake.tools.get("recall")!;
    const recalled = await recall.execute({ query: "injection policy" }, toolContext);
    assert.match(String(recalled.content), /Injection policy/);

    const get = fake.tools.get("get")!;
    const detail = await get.execute({ id: created.node!.id }, toolContext);
    assert.match(String(detail.content), /## Sources/);
  });
});

test("write permission is opt-in and the remember tool stores claims", async () => {
  await withPlugin(
    async (fake, runtime) => {
      await registerTools(fake.ctx, runtime);
      const remember = fake.tools.get("remember")!;
      const result = await remember.execute(
        {
          kind: "gotcha",
          title: "Permission test",
          body: "This claim tests the write permission path.",
          basis: "inferred",
        },
        toolContext,
      );
      assert.match(String(result.content), /Memory created/);
      assert.equal(fake.permissions.length, 1);
      assert.equal(fake.permissions[0].action, "memory.remember");
      assert.ok(runtime.store.get("gotcha/permission-test"));
    },
    { requireWritePermission: true },
  );

  await withPlugin(async (fake, runtime) => {
    await registerTools(fake.ctx, runtime);
    const remember = fake.tools.get("remember")!;
    await remember.execute(
      {
        kind: "gotcha",
        title: "No permission test",
        body: "This claim should not ask for permission.",
        basis: "inferred",
      },
      toolContext,
    );
    assert.equal(fake.permissions.length, 0);
    assert.ok(runtime.store.get("gotcha/no-permission-test"));
  });
});

test("prompt hook persists an instruction entry and context hook skips the fallback", async () => {
  await withPlugin(async (fake, runtime) => {
    seed(runtime);
    const cleanup = await registerHooks(fake.ctx, runtime);
    await fake.promptHooks[0]!({
      sessionID: "ses_test",
      messageID: "msg_1",
      prompt: { text: "What is the injection policy for inferred claims?" },
      delivery: "steer",
      metadata: {},
    } as unknown as SessionPrompt);

    assert.equal(fake.entries.size, 1);
    const entry = [...fake.entries.values()][0]!;
    assert.match(entry, /<project_memory>/);

    const system: Array<{ type: "text"; text: string }> = [];
    await fake.contextHooks[0]!({ sessionID: "ses_test", system } as unknown as SessionContext);
    assert.equal(system.length, 0);

    await cleanup();
    assert.equal(fake.removed.length, 1);
    assert.equal(fake.disposals, 2);
  });
});

test("context hook is the fallback when session instruction entries are unavailable", async () => {
  await withPlugin(
    async (fake, runtime) => {
      seed(runtime);
      await registerHooks(fake.ctx, runtime);
      await fake.promptHooks[0]!({
        sessionID: "ses_test",
        messageID: "msg_1",
        prompt: { text: "What is the injection policy for inferred claims?" },
        delivery: "steer",
        metadata: {},
      } as unknown as SessionPrompt);

      assert.equal(fake.entries.size, 0);
      const system: Array<{ type: "text"; text: string }> = [];
      await fake.contextHooks[0]!({ sessionID: "ses_test", system } as unknown as SessionContext);
      assert.equal(system.length, 1);
      assert.match(system[0]!.text, /<project_memory>/);
    },
    { withInstructions: false },
  );
});

test("auto-recall skips acknowledgements, slash commands, and explicit memory-tool prompts", async () => {
  await withPlugin(async (fake, runtime) => {
    seed(runtime);
    await registerHooks(fake.ctx, runtime);
    const prompts = ["OK", "/memory-review", "Call memory_recall with query injection policy"];
    for (const [index, text] of prompts.entries()) {
      await fake.promptHooks[0]!({
        sessionID: "ses_test",
        messageID: `msg_${index}`,
        prompt: { text },
        delivery: "steer",
        metadata: {},
      } as unknown as SessionPrompt);
    }
    assert.equal(fake.entries.size, 0);
  });
});

test("auto-recall excludes inferred claims and includes cited claims", async () => {
  await withPlugin(async (fake, runtime) => {
    runtime.store.remember(
      {
        kind: "gotcha",
        title: "Inferred policy",
        body: "The inferred policy is unverified.",
        basis: "inferred",
      },
      { author: { type: "system", id: "test" } },
    );
    await registerHooks(fake.ctx, runtime);
    await fake.promptHooks[0]!({
      sessionID: "ses_test",
      messageID: "msg_inferred",
      prompt: { text: "Explain the inferred policy in detail" },
      delivery: "steer",
      metadata: {},
    } as unknown as SessionPrompt);
    assert.equal(fake.entries.size, 0);

    seed(runtime, "Cited policy");
    await fake.promptHooks[0]!({
      sessionID: "ses_test",
      messageID: "msg_cited",
      prompt: { text: "Explain the cited policy in detail" },
      delivery: "steer",
      metadata: {},
    } as unknown as SessionPrompt);
    assert.equal(fake.entries.size, 1);
  });
});

test("skill registration reads the bundled skill and falls back when missing", async () => {
  await withPlugin(async (fake) => {
    await registerSkill(fake.ctx);
    assert.equal(fake.skills.length, 1);
    const skill = fake.skills[0];
    assert.equal(skill.id, "project-memory");
    assert.equal(skill.autoinvoke, true);
    assert.match(skill.content, /Before planning unfamiliar work/);
    assert.doesNotMatch(skill.content, /^---/);
  });

  const fallback = readSkillContent("/definitely/not/a/real/SKILL.md");
  assert.equal(fallback.fallback, true);
  assert.match(fallback.content, /Project memory/);
});
