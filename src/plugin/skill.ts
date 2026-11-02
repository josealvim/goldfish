import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Skill } from "@opencode/plugin";
import type { Registration } from "@opencode/plugin/promise/registration";
import type { PluginContext } from "./runtime.ts";

const SKILL_ID = "project-memory";
const SKILL_NAME = "Project Memory";
const SKILL_DESCRIPTION =
  "Recall and contribute project-specific knowledge (decisions, gotchas, patterns, components, docs, and past learnings) without reading whole files. Use before planning unfamiliar work and after learning a durable, non-obvious fact.";

export const SKILL_PATH = fileURLToPath(
  new URL("../../.opencode/skills/project-memory/SKILL.md", import.meta.url),
);

export const FALLBACK_CONTENT = `# Project memory

This project has a local knowledge base exposed through the \`memory\` tools.

- Before planning unfamiliar work, call \`memory_recall\` with domain terms and the paths you expect to touch.
- Read the evidence cards, then call \`memory_get\` for a full claim or \`memory_neighbors\` for relationships.
- Verify against current sources before editing. Memory is evidence, not authority.
- After learning a durable decision, gotcha, pattern, or component relationship, call \`memory_remember\` with exact citations.
- Do not store code dumps, secrets, or transient task state.
- Inferred claims are accepted but require independent verification before automatic injection. Disputed and stale claims require explicit recall.
- If a memory is wrong, cite the current source and propose a revision with \`supersedes\` or a conflict with \`contradicts\`.
`;

function stripFrontmatter(value: string): string {
  if (!value.startsWith("---")) return value;
  const end = value.indexOf("\n---", 3);
  if (end === -1) return value;
  return value.slice(end + 4).trimStart();
}

export function readSkillContent(path = SKILL_PATH): { content: string; fallback: boolean } {
  try {
    return { content: stripFrontmatter(readFileSync(path, "utf8")), fallback: false };
  } catch {
    return { content: FALLBACK_CONTENT, fallback: true };
  }
}

export async function registerSkill(ctx: PluginContext): Promise<Registration> {
  const loaded = readSkillContent();
  if (loaded.fallback) {
    console.error("project-memory: could not read the skill file; using the embedded fallback");
  }

  try {
    return await ctx.skill.transform((editor) => {
      editor.add({
        id: Skill.ID.make(SKILL_ID),
        name: Skill.Name.make(SKILL_NAME),
        description: SKILL_DESCRIPTION,
        autoinvoke: true,
        path: Skill.Info.fields.path.make(SKILL_PATH),
        content: loaded.content,
      } as never);
    });
  } catch (error) {
    console.error("project-memory: could not register the project-memory skill", error);
    return { dispose: async () => {} };
  }
}
