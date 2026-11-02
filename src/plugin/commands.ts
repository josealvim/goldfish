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
    });
  } catch (error) {
    console.error("goldfish: could not register the onboarding command", error);
    return { dispose: async () => {} };
  }
}
