import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntime, type PluginContext, type Runtime } from "../src/plugin/runtime.ts";
import { registerTools } from "../src/plugin/tools.ts";
import { registerHooks } from "../src/plugin/hooks.ts";
import { registerSkill, registerSkills, readSkillContent } from "../src/plugin/skill.ts";
import { registerCommands } from "../src/plugin/commands.ts";
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
  commands: any[];
  prompts: any[];
  generated: any[];
  disposals: number;
}

function makeFake(options: {
  root: string;
  dbPath: string;
  withInstructions?: boolean;
  requireWritePermission?: boolean;
  verificationResponse?: string;
  conflictResponse?: string | ((prompt: string) => string);
  sessionMessages?: unknown[];
}): Fake {
  const tools = new Map<string, any>();
  const promptHooks: Fake["promptHooks"] = [];
  const contextHooks: Fake["contextHooks"] = [];
  const entries = new Map<string, string>();
  const removed: string[] = [];
  const permissions: any[] = [];
  const skills: any[] = [];
  const commands: any[] = [];
  const prompts: any[] = [];
  const generated: any[] = [];
  let disposals = 0;
  const verificationResponse =
    options.verificationResponse ??
    JSON.stringify({
      verdict: "supported",
      suggestedAction: "ratify_verified",
      reason: "The cited source supports the claim.",
      evidence: [],
      premises: [],
      conflicts: [],
    });
  const conflictResponse =
    options.conflictResponse ??
    JSON.stringify({
      conflicts: [],
    });
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
    prompt: async (input: unknown) => {
      prompts.push(input);
      return {};
    },
    context: async () => options.sessionMessages ?? [],
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
    command: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({ add: (command: unknown) => commands.push(command) });
        return registration;
      },
    },
    generate: {
      text: async (input: unknown) => {
        generated.push(input);
        const prompt = String((input as { prompt?: string })?.prompt ?? "");
        const text = prompt.includes("conflict analyst")
          ? typeof conflictResponse === "function"
            ? conflictResponse(prompt)
            : conflictResponse
          : verificationResponse;
        return { text };
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
    commands,
    prompts,
    generated,
    get disposals() {
      return disposals;
    },
  };
}

async function withPlugin(
  callback: (fake: Fake, runtime: Runtime) => Promise<void> | void,
  options: {
    withInstructions?: boolean;
    requireWritePermission?: boolean;
    verificationResponse?: string;
    conflictResponse?: string | ((prompt: string) => string);
    sessionMessages?: unknown[];
  } = {},
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
    assert.deepEqual([...fake.tools.keys()].sort(), [
      "archive",
      "audit",
      "cite",
      "confirm",
      "conflict",
      "conflicts",
      "eval",
      "export_graph",
      "get",
      "health",
      "learn",
      "link",
      "list",
      "neighbors",
      "recall",
      "reject",
      "remember",
      "repair",
      "review",
      "scan",
      "stage_learning",
      "status",
      "unlink",
      "update",
      "verify",
    ]);

    const recall = fake.tools.get("recall")!;
    const recalled = await recall.execute({ query: "injection policy" }, toolContext);
    assert.match(String(recalled.content), /Injection policy/);

    const get = fake.tools.get("get")!;
    const detail = await get.execute({ id: created.node!.id }, toolContext);
    assert.match(String(detail.content), /## Sources/);
  });
});

test("memory_export_graph writes a deterministic offline explorer", async () => {
  await withPlugin(async (fake, runtime) => {
    seed(runtime);
    await registerTools(fake.ctx, runtime);
    const tool = fake.tools.get("export_graph")!;
    const first = await tool.execute({ format: "html" }, toolContext);
    const targetPath = String((first.metadata as any).path);
    assert.equal(existsSync(targetPath), true);
    assert.equal((first.metadata as any).format, "html");
    assert.equal((first.metadata as any).nodes, 1);
    const html = readFileSync(targetPath, "utf8");
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /id="goldfish-data"/);
    assert.doesNotMatch(html, /<script[^>]+src=/i);

    const second = await tool.execute({ format: "html" }, toolContext);
    assert.equal(readFileSync(String((second.metadata as any).path), "utf8"), html);

    const json = await tool.execute(
      { out: path.join(".opencode", "memory", "graph.json") },
      toolContext,
    );
    assert.equal((json.metadata as any).format, "json");
    const parsed = JSON.parse(readFileSync(String((json.metadata as any).path), "utf8"));
    assert.equal(parsed.nodes.length, 1);
  });
});

test("memory_verify applies a semantic verdict once and caches unchanged evidence", async () => {
  await withPlugin(async (fake, runtime) => {
    const created = runtime.store.remember(
      {
        kind: "gotcha",
        title: "Unverified policy",
        body: "This claim still needs a semantic check.",
        basis: "inferred",
        citations: [{ type: "file", locator: "docs/decisions.md" }],
      },
      { author: { type: "system", id: "test" } },
    ).node!;
    await registerTools(fake.ctx, runtime);

    const verify = fake.tools.get("verify")!;
    const first = await verify.execute({ ids: [created.id] }, toolContext);
    const firstResults = (first.metadata as any).results;
    assert.equal(firstResults[0].verdict, "supported");
    assert.equal(firstResults[0].basis, "cited");
    assert.equal(fake.generated.length, 1);

    const promoted = runtime.store.get(created.id)!.node;
    assert.equal(promoted.basis, "cited");
    assert.ok(promoted.metadata.ratificationSuggested);

    const second = await verify.execute({ ids: [created.id] }, toolContext);
    assert.equal((second.metadata as any).results[0].cached, true);
    assert.equal(fake.generated.length, 1);

    const review = fake.tools.get("review")!;
    const reviewed = await review.execute({}, toolContext);
    assert.match(String(reviewed.content), /ratification suggested/);
  });
});

test("memory_audit samples, runs, respects the cooldown, and records outcomes", async () => {
  await withPlugin(async (fake, runtime) => {
    const created = seed(runtime, "Audit policy");
    await registerTools(fake.ctx, runtime);

    const audit = fake.tools.get("audit")!;
    const preview = await audit.execute(
      { mode: "candidates", uniformRate: 1, riskRate: 0, limit: 10 },
      toolContext,
    );
    assert.match(String(preview.content), /Audit candidates/);
    assert.deepEqual((preview.metadata as any).ids, [created.node!.id]);

    const run = await audit.execute(
      { mode: "run", uniformRate: 1, riskRate: 0, limit: 10 },
      toolContext,
    );
    assert.equal((run.metadata as any).results[0].verdict, "supported");
    assert.equal(fake.generated.length, 1);

    const coolingDown = await audit.execute(
      { mode: "run", uniformRate: 1, riskRate: 0, limit: 10 },
      toolContext,
    );
    assert.match(String(coolingDown.content), /No audit candidates/);
    assert.equal(fake.generated.length, 1);

    const recorded = await audit.execute(
      { mode: "record", id: created.node!.id, outcome: "stale", reason: "Source changed." },
      toolContext,
    );
    assert.match(String(recorded.content), /Recorded stale audit/);
    assert.equal(runtime.store.get(created.node!.id)!.node.status, "stale");
  });
});

test("memory_conflicts proposes a conflict and memory_admin.conflict confirms it", async () => {
  await withPlugin(
    async (fake, runtime) => {
      const target = runtime.store.remember(
        {
          kind: "decision",
          title: "Conflict policy alpha",
          body: "Billing publishes through an outbox.",
          tags: ["billing"],
          citations: [{ type: "file", locator: "docs/decisions.md" }],
        },
        { author: { type: "system", id: "test" } },
      ).node!;
      const candidate = runtime.store.remember(
        {
          kind: "decision",
          title: "Conflict policy beta",
          body: "Billing publishes directly to the provider.",
          tags: ["billing"],
          citations: [{ type: "file", locator: "docs/decisions.md" }],
        },
        { author: { type: "system", id: "test" } },
      ).node!;
      await registerTools(fake.ctx, runtime);

      const conflicts = fake.tools.get("conflicts")!;
      const discovered = await conflicts.execute(
        { ids: [target.id], candidatesPerClaim: 3 },
        toolContext,
      );
      assert.match(String(discovered.content), /1 proposed conflict/);
      const proposal = runtime.store.getConflictProposal(target.id, candidate.id)!;
      assert.equal(proposal.status, "proposed");
      assert.equal(runtime.store.get(target.id)!.node.status, "active");
      assert.equal(runtime.store.get(candidate.id)!.node.status, "active");

      const repeat = await conflicts.execute(
        { ids: [target.id], candidatesPerClaim: 3 },
        toolContext,
      );
      assert.match(String(repeat.content), /0 candidate\(s\)/);
      assert.equal(fake.generated.length, 1);

      const review = fake.tools.get("review")!;
      const reviewed = await review.execute({}, toolContext);
      assert.match(String(reviewed.content), /Proposed conflicts/);
      assert.match(String(reviewed.content), /memory_admin\.conflict/);

      const admin = fake.tools.get("conflict")!;
      const confirmed = await admin.execute(
        {
          action: "confirm",
          from: target.id,
          to: candidate.id,
          reason: "The sources cannot both be true.",
        },
        toolContext,
      );
      assert.match(String(confirmed.content), /both claims are disputed/);
      assert.equal(runtime.store.get(target.id)!.node.status, "disputed");
      assert.equal(runtime.store.get(candidate.id)!.node.status, "disputed");
      assert.equal(
        runtime.store.getConflictProposal(target.id, candidate.id)!.status,
        "confirmed",
      );
      assert.equal(fake.permissions.length, 1);
    },
    {
      conflictResponse: JSON.stringify({
        conflicts: [
          {
            id: "decision/conflict-policy-beta",
            relation: "contradicts",
            reason: "One claim uses an outbox; the other publishes directly.",
            evidence: [
              {
                locator: "file:docs/decisions.md",
                quote: "Injection policy.",
                why: "The source describes the delivery path.",
              },
            ],
          },
        ],
      }),
    },
  );
});

test("memory_admin.confirm and reject complete the human review loop", async () => {
  await withPlugin(async (fake, runtime) => {
    const cited = runtime.store.remember(
      {
        kind: "decision",
        title: "Review cited claim",
        body: "A reviewed claim with a source.",
        basis: "inferred",
        citations: [{ type: "file", locator: "docs/decisions.md" }],
        metadata: {
          ratificationSuggested: { basis: "verified", reason: "Model suggested it." },
        },
      },
      { author: { type: "system", id: "test" } },
    ).node!;
    const tested = runtime.store.remember(
      {
        kind: "decision",
        title: "Review tested claim",
        body: "A reviewed claim with a test.",
        basis: "inferred",
        citations: [{ type: "test", locator: "npm test" }],
      },
      { author: { type: "system", id: "test" } },
    ).node!;
    const rejected = runtime.store.remember(
      {
        kind: "gotcha",
        title: "Review rejected claim",
        body: "A claim that should be rejected.",
        basis: "inferred",
        citations: [{ type: "file", locator: "docs/decisions.md" }],
        metadata: {
          ratificationSuggested: { basis: "verified", reason: "Model suggested it." },
        },
      },
      { author: { type: "system", id: "test" } },
    ).node!;
    await registerTools(fake.ctx, runtime);

    const review = fake.tools.get("review")!;
    const reviewed = await review.execute({}, toolContext);
    assert.match(String(reviewed.content), /Next: memory_admin\.confirm/);

    const confirm = fake.tools.get("confirm")!;
    const citedResult = await confirm.execute(
      { id: cited.id, as: "cited", reason: "Source checked by a human." },
      toolContext,
    );
    assert.match(String(citedResult.content), /Basis: cited/);
    const citedNode = runtime.store.get(cited.id)!.node;
    assert.equal(citedNode.basis, "cited");
    assert.equal(citedNode.metadata.ratificationSuggested, undefined);
    assert.equal(runtime.store.get(cited.id)!.citations.length, 1);

    const verifiedResult = await confirm.execute(
      { id: tested.id, as: "verified", reason: "The test passes." },
      toolContext,
    );
    assert.match(String(verifiedResult.content), /Basis: verified/);
    const verifiedDetail = runtime.store.get(tested.id)!;
    assert.equal(verifiedDetail.node.basis, "verified");
    assert.equal(verifiedDetail.citations.length, 2);
    assert.equal(verifiedDetail.citations.some((citation) => citation.type === "human"), true);
    assert.equal(fake.permissions.length, 1);

    const reject = fake.tools.get("reject")!;
    const rejectedResult = await reject.execute(
      { id: rejected.id, reason: "The source contradicts this claim." },
      toolContext,
    );
    assert.match(String(rejectedResult.content), /Verification: rejected/);
    const rejectedDetail = runtime.store.get(rejected.id)!;
    assert.equal(rejectedDetail.node.verificationState, "rejected");
    assert.equal(rejectedDetail.node.autoInjectEligible, false);
    assert.equal(rejectedDetail.citations.length, 1);
    assert.equal(rejectedDetail.node.metadata.ratificationSuggested, undefined);

    const derivedBase = runtime.store.remember(
      {
        kind: "decision",
        title: "Review derived premise",
        body: "A cited premise.",
        citations: [{ type: "file", locator: "docs/decisions.md" }],
      },
      { author: { type: "system", id: "test" } },
    ).node!;
    const derived = runtime.store.remember(
      {
        kind: "decision",
        title: "Review derived claim",
        body: "A claim derived from a cited premise.",
        basis: "derived",
        links: [{ to: derivedBase.id, type: "derived_from" }],
      },
      { author: { type: "system", id: "test" } },
    ).node!;
    const derivedResult = await confirm.execute(
      { id: derived.id, as: "derived", reason: "The premise is cited and sound." },
      toolContext,
    );
    assert.match(String(derivedResult.content), /Basis: derived/);
    assert.equal(runtime.store.get(derived.id)!.node.basis, "derived");

    const unsupported = runtime.store.remember(
      {
        kind: "gotcha",
        title: "Review uncited claim",
        body: "A claim without a citation.",
        basis: "inferred",
      },
      { author: { type: "system", id: "test" } },
    ).node!;
    await assert.rejects(
      confirm.execute(
        { id: unsupported.id, as: "cited", reason: "No source." },
        toolContext,
      ),
      /without a citation/,
    );
  });
});

test("memory_eval runs a bundled support suite without touching project memory", async () => {
  await withPlugin(async (fake, runtime) => {
    await registerTools(fake.ctx, runtime);
    const evaluate = fake.tools.get("eval")!;
    const result = await evaluate.execute(
      {
        suite: "support",
        file: path.resolve("evals/support.jsonl"),
        limit: 2,
      },
      toolContext,
    );
    assert.match(String(result.content), /Support evaluation/);
    assert.equal((result.metadata as any).support.total, 2);
    assert.equal(runtime.store.status().total, 0);
  });
});

test("memory_scan returns a read-only structural scan", async () => {
  await withPlugin(async (fake, runtime) => {
    await registerTools(fake.ctx, runtime);
    const scan = fake.tools.get("scan")!;
    const result = await scan.execute({ maxFiles: 10, includeGit: false }, toolContext);
    assert.match(String(result.content), /Project scan/);
    assert.equal((result.metadata as any).git, false);
    assert.equal(runtime.store.status().total, 0);
  });
});

test("memory_learn digests text and stage_learning writes a review file", async () => {
  await withPlugin(
    async (fake, runtime) => {
      await registerTools(fake.ctx, runtime);
      const learn = fake.tools.get("learn")!;
      const digest = await learn.execute({ maxMessages: 5 }, toolContext);
      assert.match(String(digest.content), /Session digest/);
      assert.match(String(digest.content), /We decided to use an outbox/);
      assert.match(String(digest.content), /The outbox retries deliveries/);
      assert.doesNotMatch(String(digest.content), /hidden reasoning/);
      assert.doesNotMatch(String(digest.content), /tool argument/);

      const stage = fake.tools.get("stage_learning")!;
      const staged = await stage.execute(
        {
          candidates: [
            {
              kind: "decision",
              title: "Use an outbox",
              body: "Billing uses an outbox for delivery.",
              citations: [
                {
                  type: "session",
                  locator: "ses_test/msg_user",
                  excerpt: "We decided to use an outbox.",
                },
              ],
            },
          ],
        },
        toolContext,
      );
      const file = String((staged.metadata as any).path);
      const lines = readFileSync(file, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);
      const record = JSON.parse(lines[0]!);
      assert.equal(record.status, "pending");
      assert.equal(record.id, "c1");
      assert.equal(record.title, "Use an outbox");
      assert.equal(runtime.store.status().total, 0);
    },
    {
      sessionMessages: [
        { id: "msg_user", type: "user", text: "We decided to use an outbox." },
        {
          id: "msg_assistant",
          type: "assistant",
          content: [
            { type: "text", text: "The outbox retries deliveries." },
            { type: "reasoning", text: "hidden reasoning" },
            { type: "tool", id: "tool_1", name: "read", state: { input: "tool argument" } },
          ],
        },
        { id: "msg_system", type: "system", text: "system prompt" },
      ],
    },
  );
});

test("memory_repair returns a read-only repair packet", async () => {
  await withPlugin(async (fake, runtime) => {
    const created = seed(runtime);
    await registerTools(fake.ctx, runtime);
    const repair = fake.tools.get("repair")!;
    const result = await repair.execute({ id: created.node!.id }, toolContext);
    assert.match(String(result.content), /Repair packet/);
    assert.equal((result.metadata as any).tier, "none");
    assert.deepEqual((result.metadata as any).actions, ["leave_for_review"]);
    assert.equal(runtime.store.get(created.node!.id)!.node.version, 1);
  });
});

test("memory_status reports onboarding progress through empty, recommended, partial, and complete", async () => {
  await withPlugin(async (fake, runtime) => {
    await registerTools(fake.ctx, runtime);
    const statusTool = fake.tools.get("status")!;
    const status = async () => {
      const result = await statusTool.execute({}, toolContext);
      return { content: String(result.content), metadata: result.metadata as any };
    };

    const empty = await status();
    assert.match(empty.content, /Onboarding: empty/);
    assert.match(empty.content, /Project ID: path-derived/);
    assert.match(empty.content, /Database: .* \(explicit\)/);
    assert.equal(empty.metadata.onboardingRecommended, true);
    assert.equal(empty.metadata.project.identity, "path");
    assert.equal(empty.metadata.project.storeKind, "explicit");

    runtime.store.remember(
      {
        kind: "concept",
        title: "Project overview",
        body: "The project overview.",
        citations: [{ type: "file", locator: "docs/decisions.md" }],
      },
      { author: { type: "system", id: "test" } },
    );
    const overviewOnly = await status();
    assert.match(overviewOnly.content, /Onboarding: recommended/);
    assert.equal(overviewOnly.metadata.overview, true);

    runtime.store.remember(
      {
        kind: "component",
        title: "Core component",
        body: "The core component.",
        citations: [{ type: "file", locator: "docs/decisions.md" }],
        links: [{ to: "concept/project-overview", type: "part_of" }],
      },
      { author: { type: "system", id: "test" } },
    );
    const partial = await status();
    assert.match(partial.content, /Onboarding: partial/);

    seed(runtime, "Core decision");
    const stillPartial = await status();
    assert.match(stillPartial.content, /Onboarding: partial/);

    runtime.store.remember(
      {
        kind: "gotcha",
        title: "Core gotcha",
        body: "The core gotcha.",
        citations: [{ type: "file", locator: "docs/decisions.md" }],
      },
      { author: { type: "system", id: "test" } },
    );
    const complete = await status();
    assert.match(complete.content, /Onboarding: complete/);
    assert.equal(complete.metadata.state, "complete");
    assert.equal(complete.metadata.onboardingRecommended, false);
  });
});

test("memory_list handles an empty store without undefined metadata", async () => {
  await withPlugin(async (fake, runtime) => {
    await registerTools(fake.ctx, runtime);
    const list = fake.tools.get("list")!;
    const result = await list.execute({ limit: 5 }, toolContext);
    assert.match(String(result.content), /No memory nodes matched/);
    assert.equal((result.metadata as any).total, 0);
    assert.equal("nextOffset" in (result.metadata as any), false);
  });
});

test("memory_list and memory_health expose read-only diagnostics", async () => {
  await withPlugin(async (fake, runtime) => {
    seed(runtime);
    await registerTools(fake.ctx, runtime);

    const list = fake.tools.get("list")!;
    const listed = await list.execute({ kinds: ["decision"], limit: 10 }, toolContext);
    assert.match(String(listed.content), /Memory list/);
    assert.match(String(listed.content), /Injection policy/);
    assert.equal((listed.metadata as any).total, 1);

    const health = fake.tools.get("health")!;
    const report = await health.execute({}, toolContext);
    assert.match(String(report.content), /# Memory health/);
    assert.match(String(report.content), /Citation coverage/);
    assert.equal((report.metadata as any).onboarding, "recommended");
  });
});

test("memory_admin tools cite, link, unlink, update, and archive", async () => {
  await withPlugin(async (fake, runtime) => {
    const first = seed(runtime, "Admin first");
    const second = seed(runtime, "Admin second");
    await registerTools(fake.ctx, runtime);

    for (const name of ["cite", "link", "unlink", "update", "archive"]) {
      assert.equal(fake.tools.get(name)?.options?.namespace, "memory_admin", `${name} namespace`);
    }

    const cite = fake.tools.get("cite")!;
    const cited = await cite.execute(
      { id: first.node!.id, citations: [{ type: "file", locator: "docs/decisions.md" }] },
      toolContext,
    );
    assert.match(String(cited.content), /## Sources/);

    const link = fake.tools.get("link")!;
    await link.execute(
      { from: first.node!.id, to: second.node!.id, type: "depends_on" },
      toolContext,
    );
    assert.ok(
      runtime.store
        .get(first.node!.id)
        ?.edges.some((edge) => edge.type === "depends_on" && edge.toID === second.node!.id),
    );

    const unlink = fake.tools.get("unlink")!;
    await unlink.execute(
      { from: first.node!.id, to: second.node!.id, type: "depends_on" },
      toolContext,
    );
    assert.equal(
      runtime.store.get(first.node!.id)?.edges.some((edge) => edge.type === "depends_on"),
      false,
    );

    const update = fake.tools.get("update")!;
    const updated = await update.execute(
      { id: first.node!.id, title: "Admin renamed", scope: ["src/**"], tags: ["admin"] },
      toolContext,
    );
    assert.match(String(updated.content), /Admin renamed/);
    assert.equal(runtime.store.get(first.node!.id)?.node.title, "Admin renamed");
    assert.equal(runtime.store.get(first.node!.id)?.node.id, first.node!.id);

    const archive = fake.tools.get("archive")!;
    await archive.execute({ id: second.node!.id, reason: "test" }, toolContext);
    assert.equal(runtime.store.get(second.node!.id)?.node.status, "archived");
    assert.equal(fake.permissions.length, 1);
    assert.equal(fake.permissions[0].action, "memory.archive");
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
    assert.match(skill.content, /memory stabilize/);
    assert.match(skill.content, /path-derived/);
    assert.doesNotMatch(skill.content, /^---/);
  });

  const fallback = readSkillContent("/definitely/not/a/real/SKILL.md");
  assert.equal(fallback.fallback, true);
  assert.match(fallback.content, /Project memory/);
  assert.match(fallback.content, /memory_conflicts/);
  assert.match(fallback.content, /memory_eval/);
  assert.match(fallback.content, /memory_repair/);
  assert.match(fallback.content, /memory_scan/);
  assert.match(fallback.content, /memory_learn/);
  assert.match(fallback.content, /memory_admin\.confirm/);
  assert.match(fallback.content, /memory stabilize/);
  assert.match(fallback.content, /path-derived/);
});

test("registerSkills registers the daily, onboarding, verification, repair, and learn skills", async () => {
  await withPlugin(async (fake) => {
    await registerSkills(fake.ctx);
    assert.equal(fake.skills.length, 5);
    const byID = new Map(fake.skills.map((skill) => [skill.id, skill]));
    assert.equal(byID.has("project-memory"), true);
    const onboarding = byID.get("goldfish-onboarding");
    assert.equal(onboarding?.autoinvoke, true);
    assert.match(onboarding?.content ?? "", /12 files/);
    assert.match(onboarding?.content ?? "", /10–15/);
    assert.match(onboarding?.content ?? "", /concept\/project-overview/);
    assert.match(onboarding?.content ?? "", /exact title/);
    assert.match(onboarding?.content ?? "", /suggest/i);
    assert.match(onboarding?.content ?? "", /Write nothing/);
    assert.match(onboarding?.content ?? "", /human, a reproducible test, or a commit/);
    assert.match(onboarding?.content ?? "", /memory stabilize/);
    assert.match(onboarding?.content ?? "", /moved or renamed/);
    assert.match(onboarding?.content ?? "", /fresh clone is expected to start empty/i);
    const verification = byID.get("goldfish-verification");
    assert.equal(verification?.autoinvoke, true);
    assert.match(verification?.content ?? "", /memory_verify/);
    assert.match(verification?.content ?? "", /memory_conflicts/);
    assert.match(verification?.content ?? "", /memory_eval/);
    assert.match(verification?.content ?? "", /goldfish-ratify/);
    assert.match(verification?.content ?? "", /must not set .*verified/i);
    const repair = byID.get("goldfish-repair");
    assert.equal(repair?.autoinvoke, true);
    assert.match(repair?.content ?? "", /memory_repair/);
    assert.match(repair?.content ?? "", /human authority/);
    assert.match(repair?.content ?? "", /Never auto-resolve a conflict/);
    const learn = byID.get("goldfish-learn");
    assert.equal(learn?.autoinvoke, true);
    assert.match(learn?.content ?? "", /memory_learn/);
    assert.match(learn?.content ?? "", /memory_stage_learning/);
    assert.match(learn?.content ?? "", /Never silently discard/);
  });
});

test("the onboarding command injects a scoped onboarding prompt", async () => {
  await withPlugin(async (fake) => {
    await registerCommands(fake.ctx);
    assert.deepEqual(
      fake.commands.map((command) => command.name),
      [
        "goldfish-onboard",
        "goldfish-scan",
        "goldfish-graph",
        "goldfish-learn",
        "goldfish-verify",
        "goldfish-audit",
        "goldfish-conflicts",
        "goldfish-eval",
        "goldfish-review",
        "goldfish-repair",
        "goldfish-ratify",
        "goldfish-reject",
      ],
    );
    const command = fake.commands[0];
    await command.execute({
      sessionID: "ses_test",
      prompt: { text: "packages/billing" },
      delivery: "steer",
    });
    assert.equal(fake.prompts.length, 1);
    const text = String(fake.prompts[0].text);
    assert.match(text, /packages\/billing/);
    assert.match(text, /goldfish-onboarding/);
    assert.match(text, /12 files/);
    assert.match(text, /concept\/project-overview/);
    assert.match(text, /exact title/);
    assert.match(text, /human, test, or commit/);

    await command.execute({
      sessionID: "ses_test",
      prompt: { text: "   " },
      delivery: "steer",
    });
    assert.match(String(fake.prompts[1].text), /Scope: whole project/);

    await fake.commands[1].execute({
      sessionID: "ses_test",
      prompt: { text: "src/core" },
      delivery: "steer",
    });
    assert.match(String(fake.prompts[2].text), /memory_scan/);
    assert.match(String(fake.prompts[2].text), /src\/core/);

    await fake.commands[2].execute({
      sessionID: "ses_test",
      prompt: { text: "html" },
      delivery: "steer",
    });
    assert.match(String(fake.prompts[3].text), /memory_export_graph/);
    assert.match(String(fake.prompts[3].text), /offline HTML/);

    await fake.commands[3].execute({
      sessionID: "ses_test",
      prompt: { text: "ses_test" },
      delivery: "steer",
    });
    assert.match(String(fake.prompts[4].text), /memory_learn/);
    assert.match(String(fake.prompts[4].text), /ses_test/);

    await fake.commands[4].execute({
      sessionID: "ses_test",
      prompt: { text: "decision/billing" },
      delivery: "steer",
    });
    assert.match(String(fake.prompts[5].text), /memory_verify/);
    assert.match(String(fake.prompts[5].text), /decision\/billing/);

    await fake.commands[5].execute({
      sessionID: "ses_test",
      prompt: { text: "" },
      delivery: "steer",
    });
    assert.match(String(fake.prompts[6].text), /memory_audit/);

    await fake.commands[6].execute({
      sessionID: "ses_test",
      prompt: { text: "decision/example" },
      delivery: "steer",
    });
    assert.match(String(fake.prompts[7].text), /memory_conflicts/);
    assert.match(String(fake.prompts[7].text), /decision\/example/);

    await fake.commands[7].execute({
      sessionID: "ses_test",
      prompt: { text: "support" },
      delivery: "steer",
    });
    assert.match(String(fake.prompts[8].text), /memory_eval/);
    assert.match(String(fake.prompts[8].text), /support/);

    await fake.commands[8].execute({
      sessionID: "ses_test",
      prompt: { text: "" },
      delivery: "steer",
    });
    assert.match(String(fake.prompts[9].text), /memory_review/);

    await fake.commands[9].execute({
      sessionID: "ses_test",
      prompt: { text: "decision/example" },
      delivery: "steer",
    });
    assert.match(String(fake.prompts[10].text), /memory_repair/);
    assert.match(String(fake.prompts[10].text), /decision\/example/);

    await fake.commands[10].execute({
      sessionID: "ses_test",
      prompt: { text: "decision/example as=verified" },
      delivery: "steer",
    });
    assert.match(String(fake.prompts[11].text), /memory_admin\.confirm/);
    assert.match(String(fake.prompts[11].text), /human, test, or commit/);

    await fake.commands[11].execute({
      sessionID: "ses_test",
      prompt: { text: "gotcha/example" },
      delivery: "steer",
    });
    assert.match(String(fake.prompts[12].text), /memory_admin\.reject/);
  });
});
