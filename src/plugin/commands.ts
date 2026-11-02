import type { Registration } from "@opencode/plugin/promise/registration";
import type { PluginContext } from "./runtime.ts";

export async function registerCommands(ctx: PluginContext): Promise<Registration> {
  try {
    return await ctx.command.transform((editor) => {
      editor.add({
        name: "goldfish-onboard",
        description: "Bootstrap goldfish project memory with a bounded, cited onboarding pass.",
        execute: async ({ sessionID, prompt, delivery }) => {
          const scope = prompt.text.trim().replace(/\s+/g, " ").slice(0, 200);
          const text = [
            "Onboard to this project using goldfish.",
            scope ? `Scope: ${scope}` : "Scope: whole project.",
            "Follow the goldfish-onboarding skill.",
            "Start with memory_status and memory_recall. Read at most 12 files / 4,000 lines.",
            "Create at most 10–15 new cited nodes: one concept/project-overview, 3–5 components, 3–5 decisions/patterns, and 3–5 gotchas/runbooks.",
            "Use the exact title 'Project overview' for concept/project-overview and leave its scope empty.",
            "Write cited claims immediately. Do not use verified without a human or test.",
            "Ask before exceeding the first-pass budget.",
            "Finish with an onboarding report and memory_status.",
          ].join("\n");
          await ctx.session.prompt({ ...prompt, sessionID, text, delivery });
        },
      });

      editor.add({
        name: "goldfish-verify",
        description:
          "Verify inferred or unverified claims against their cited sources with a rejection-leaning verifier.",
        execute: async ({ sessionID, prompt, delivery }) => {
          const target = prompt.text.trim().replace(/\s+/g, " ").slice(0, 200);
          const text = [
            "Run a goldfish verification pass.",
            target ? `Target: ${target}` : "Target: the highest-priority review items.",
            "Follow the goldfish-verification skill.",
            "Start with memory_review, then read the cited sources yourself before verifying.",
            "Call memory_verify with explicit IDs for the claims you checked, or with a scope.",
            "Verify at most 5 claims in one run unless the user asks for more.",
            "Do not use memory confirm or force verified. The verifier may promote to cited/derived,",
            "mark stale, flag conflicts, or suggest ratification to verified. Only a human or test can verify.",
            "Report each claim, verdict, reason, and any source that needs a human decision.",
          ].join("\n");
          await ctx.session.prompt({ ...prompt, sessionID, text, delivery });
        },
      });

      editor.add({
        name: "goldfish-audit",
        description: "Run a sampled audit of auto-inject-eligible memory claims.",
        execute: async ({ sessionID, prompt, delivery }) => {
          const target = prompt.text.trim().replace(/\s+/g, " ").slice(0, 200);
          const text = [
            "Run a goldfish memory audit.",
            target ? `Target: ${target}` : "Target: the default 3% uniform plus 7% risk-weighted sample.",
            "Follow the goldfish-verification skill.",
            "Call memory_audit with mode=candidates first when the user asks for a preview or a custom rate.",
            "Then call memory_audit with mode=run. Do not audit more than 10 claims in one run.",
            "Audits may mark claims stale, disputed, archived, or needs-human. They never resolve a conflict",
            "automatically. Report the sampled IDs, outcomes, and any claim that needs a human.",
          ].join("\n");
          await ctx.session.prompt({ ...prompt, sessionID, text, delivery });
        },
      });

      editor.add({
        name: "goldfish-review",
        description: "Show the memory review queue and explain what needs attention.",
        execute: async ({ sessionID, prompt, delivery }) => {
          const target = prompt.text.trim().replace(/\s+/g, " ").slice(0, 200);
          const text = [
            "Show the goldfish memory review queue.",
            target ? `Scope: ${target}` : "",
            "Follow the goldfish-verification skill.",
            "Call memory_review, then group items by reason: unverified, needs-human, disputed, stale,",
            "rejected, and ratification suggested. Use memory_get for details on the highest-priority items.",
            "This is read-only unless the user asks for a repair or verification pass.",
          ]
            .filter(Boolean)
            .join("\n");
          await ctx.session.prompt({ ...prompt, sessionID, text, delivery });
        },
      });
    });
  } catch (error) {
    console.error("goldfish: could not register the onboarding command", error);
    return { dispose: async () => {} };
  }
}
