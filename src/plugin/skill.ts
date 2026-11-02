import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Skill } from "@opencode/plugin";
import type { Registration } from "@opencode/plugin/promise/registration";
import type { PluginContext } from "./runtime.ts";

interface SkillSpec {
  id: string;
  name: string;
  description: string;
  path: string;
  fallback: string;
}

export const SKILL_PATH = fileURLToPath(
  new URL("../../.opencode/skills/project-memory/SKILL.md", import.meta.url),
);

export const ONBOARDING_SKILL_PATH = fileURLToPath(
  new URL("../../.opencode/skills/goldfish-onboarding/SKILL.md", import.meta.url),
);

export const VERIFICATION_SKILL_PATH = fileURLToPath(
  new URL("../../.opencode/skills/goldfish-verification/SKILL.md", import.meta.url),
);

export const FALLBACK_CONTENT = `# Project memory

This project has a local knowledge base exposed through the \`memory\` tools.

- Call \`memory_status\` before a large planning task. If onboarding is empty or
  recommended, suggest \`/goldfish-onboard\`.
- Use \`memory_health\` and \`memory_list\` for maintenance; use the
  \`memory_admin\` namespace for precise cite/link/unlink/update/archive changes.
- Use \`memory_review\`, \`memory_verify\`, and \`memory_audit\` before relying on
  unverified, disputed, or stale claims.
- Before planning unfamiliar work, call \`memory_recall\` with domain terms and the
  paths you expect to touch.
- Read the evidence cards, then call \`memory_get\` for a full claim or
  \`memory_neighbors\` for relationships.
- Verify against current sources before editing. Memory is evidence, not authority.
- After learning a durable decision, gotcha, pattern, or component relationship,
  call \`memory_remember\` with exact citations.
- Do not store code dumps, secrets, or transient task state.
- Inferred claims are accepted but require independent verification before
  automatic injection. Disputed and stale claims require explicit recall.
- If a memory is wrong, cite the current source and propose a revision with
  \`supersedes\` or a conflict with \`contradicts\`.
`;

const ONBOARDING_FALLBACK_CONTENT = `# Goldfish onboarding

Use this when a project is new to goldfish or memory is empty.

## Guard

If memory is empty and the user did not ask to onboard, suggest
\`/goldfish-onboard\` and write nothing. If the user asks to get oriented, you may
write the single cited \`concept/project-overview\` node, then ask before
continuing. If the user invoked \`/goldfish-onboard\` or explicitly asked to
onboard, run the bounded first pass. Use \`derived\` only for a claim whose
premises are already cited or verified and linked with \`derived_from\`.

## Workflow

1. Call \`memory_status\` and \`memory_recall\` for the project overview,
   architecture, decisions, conventions, and gotchas.
2. Read at most 12 files / 4,000 lines: README, manifests, docs/ADRs, CI config,
   build/test entry points, and top-level layout. Do not read generated code or
   secrets.
3. Create exactly \`concept/project-overview\` with the title \`Project overview\`
   and leave its scope empty. Create 3–5 \`component\` nodes with scope and
   \`part_of\` links to the overview.
4. Create 3–5 \`decision\`/\`pattern\` nodes and 3–5 \`gotcha\`/\`runbook\` nodes,
   linked with \`applies_to\`.
5. Revise the overview with a richer summary and \`related_to\` links.
6. Validate with \`memory_recall\`, \`memory_neighbors\`, and \`memory_status\`.

Write at most 10–15 new nodes in the first pass. Use \`cited\` for source-backed
claims and \`inferred\` for guesses. A body is only \`cited\` if every sentence is
supported by a citation. Never use \`verified\` without a human or test. Cite
exact files. Do not store code dumps, secrets, or transient state. Report what
was stored, what is uncertain, and what should be confirmed next.
`;

const VERIFICATION_FALLBACK_CONTENT = `# Goldfish verification

Use this when the user invokes \`/goldfish-verify\`, \`/goldfish-audit\`, or
\`/goldfish-review\`, or before relying on an unverified, disputed, or stale
claim.

Call \`memory_review\` first, then \`memory_get\` for the claims that matter. Read
the cited sources yourself. \`memory_verify\` runs deterministic checks and, when
a model is configured, a rejection-leaning semantic verifier. It may promote an
inferred claim to \`cited\` or \`derived\`, mark a claim stale, dispute both sides
of a conflict, archive malicious content, or queue a claim for human review.

It never makes a claim \`verified\`. Only a human, a reproducible test, or a
commit can do that. A model may suggest ratification, which appears in the
review queue.

\`memory_audit\` samples auto-inject-eligible claims with 3% uniform plus 7%
risk-weighted slots. Use \`mode=candidates\` to preview, \`mode=run\` to audit, and
\`mode=record\` to record an external outcome. Conflicts leave both sides
disputed and are never auto-resolved. Do not audit more than 10 claims per run.
`;

const PROJECT_MEMORY_SKILL: SkillSpec = {
  id: "project-memory",
  name: "Project Memory",
  description:
    "Recall and contribute project-specific knowledge (decisions, gotchas, patterns, components, docs, and past learnings) without reading whole files. Use before planning unfamiliar work and after learning a durable, non-obvious fact.",
  path: SKILL_PATH,
  fallback: FALLBACK_CONTENT,
};

const ONBOARDING_SKILL: SkillSpec = {
  id: "goldfish-onboarding",
  name: "Goldfish Onboarding",
  description:
    "Bootstrap goldfish project memory in a project that is new to goldfish or has empty memory. Use when the user asks to onboard, get oriented, or establish project memory. Do not use for routine recall. Check memory_status first; if memory already has an overview and components, only fill gaps.",
  path: ONBOARDING_SKILL_PATH,
  fallback: ONBOARDING_FALLBACK_CONTENT,
};

const VERIFICATION_SKILL: SkillSpec = {
  id: "goldfish-verification",
  name: "Goldfish Verification",
  description:
    "Verify, audit, and review goldfish project-memory claims. Use when the user invokes /goldfish-verify, /goldfish-audit, or /goldfish-review, when memory has unverified/disputed/stale claims, or before relying on a high-impact memory claim.",
  path: VERIFICATION_SKILL_PATH,
  fallback: VERIFICATION_FALLBACK_CONTENT,
};

function stripFrontmatter(value: string): string {
  if (!value.startsWith("---")) return value;
  const end = value.indexOf("\n---", 3);
  if (end === -1) return value;
  return value.slice(end + 4).trimStart();
}

export function readSkillContent(
  path = SKILL_PATH,
  fallback = FALLBACK_CONTENT,
): { content: string; fallback: boolean } {
  try {
    return { content: stripFrontmatter(readFileSync(path, "utf8")), fallback: false };
  } catch {
    return { content: fallback, fallback: true };
  }
}

async function registerSpecs(ctx: PluginContext, specs: SkillSpec[]): Promise<Registration> {
  try {
    return await ctx.skill.transform((editor) => {
      for (const spec of specs) {
        const loaded = readSkillContent(spec.path, spec.fallback);
        if (loaded.fallback) {
          console.error(`goldfish: could not read the ${spec.id} skill file; using the embedded fallback`);
        }
        editor.add({
          id: Skill.ID.make(spec.id),
          name: Skill.Name.make(spec.name),
          description: spec.description,
          autoinvoke: true,
          path: Skill.Info.fields.path.make(spec.path),
          content: loaded.content,
        } as never);
      }
    });
  } catch (error) {
    console.error("goldfish: could not register project skills", error);
    return { dispose: async () => {} };
  }
}

export async function registerSkill(ctx: PluginContext): Promise<Registration> {
  return registerSpecs(ctx, [PROJECT_MEMORY_SKILL]);
}

export async function registerSkills(ctx: PluginContext): Promise<Registration> {
  return registerSpecs(ctx, [PROJECT_MEMORY_SKILL, ONBOARDING_SKILL, VERIFICATION_SKILL]);
}
