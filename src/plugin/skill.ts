import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Skill } from "@opencode/plugin";
import type { Registration } from "@opencode/plugin/promise/registration";
import type { PluginContext } from "./runtime.ts";

export const SKILLS_ROOT = fileURLToPath(
  new URL("../../.opencode/skills", import.meta.url),
);

export interface BundledSkill {
  id: string;
  name: string;
  description: string;
  autoinvoke: boolean;
  path: string;
  content: string;
}

interface ParsedSkill {
  name: string;
  description: string;
  autoinvoke: boolean;
  body: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unquote(value: string): string {
  if (value.length < 2) return value;
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

function invalidFrontmatter(file: string, reason: string): Error {
  return new Error(`goldfish: invalid skill frontmatter in ${file}: ${reason}`);
}

export function parseSkillFrontmatter(file: string, raw: string): ParsedSkill {
  const text = raw.replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  if (lines[0] !== "---") {
    throw invalidFrontmatter(file, 'expected a leading "---" line');
  }
  const closing = lines.indexOf("---", 1);
  if (closing === -1) {
    throw invalidFrontmatter(file, 'missing the closing "---" line');
  }

  let section = "";
  let name: string | undefined;
  let description: string | undefined;
  let autoinvoke: boolean | undefined;

  for (const line of lines.slice(1, closing)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;

    if (indent === 0) {
      const match = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
      if (!match) throw invalidFrontmatter(file, `cannot parse line ${JSON.stringify(line)}`);
      section = match[1]!;
      const value = unquote(match[2]!.trim());

      if (section === "name" || section === "description") {
        if (!value) throw invalidFrontmatter(file, `missing ${section}`);
        if (value.startsWith("|") || value.startsWith(">")) {
          throw invalidFrontmatter(file, `multi-line ${section} is not supported`);
        }
        if (section === "name") name = value;
        else description = value;
      } else if (section === "metadata" && value) {
        throw invalidFrontmatter(file, "metadata must be a block");
      }
      continue;
    }

    if (section === "metadata") {
      const match = /^\s+([A-Za-z0-9_./-]+):[ \t]*(.*)$/.exec(line);
      if (!match) throw invalidFrontmatter(file, `cannot parse metadata line ${JSON.stringify(line)}`);
      if (match[1] === "opencode/autoinvoke") {
        const value = unquote(match[2]!.trim());
        if (value !== "true" && value !== "false") {
          throw invalidFrontmatter(file, "metadata.opencode/autoinvoke must be true or false");
        }
        autoinvoke = value === "true";
      }
      continue;
    }

    if (section === "name" || section === "description") {
      throw invalidFrontmatter(file, `multi-line ${section} is not supported`);
    }
  }

  if (!name) throw invalidFrontmatter(file, "missing name");
  if (!description) throw invalidFrontmatter(file, "missing description");
  if (autoinvoke === undefined) {
    throw invalidFrontmatter(file, "missing metadata.opencode/autoinvoke");
  }

  const body = lines.slice(closing + 1).join("\n").trimStart();
  if (!body) throw invalidFrontmatter(file, "empty skill body");
  return { name, description, autoinvoke, body };
}

function readSkillFile(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`goldfish: cannot read skill file ${file}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

function loadSkill(root: string, id: string): BundledSkill {
  const file = path.join(root, id, "SKILL.md");
  const parsed = parseSkillFrontmatter(file, readSkillFile(file));
  return {
    id,
    name: parsed.name,
    description: parsed.description,
    autoinvoke: parsed.autoinvoke,
    path: file,
    content: parsed.body,
  };
}

/**
 * Discover bundled skills from the filesystem.
 *
 * The skill directory name is the ID. The SKILL.md frontmatter is the only
 * source for name, description, and autoinvoke; no fallback text is embedded in
 * TypeScript. Any missing or malformed skill is an error.
 */
export function discoverSkills(root: string = SKILLS_ROOT): BundledSkill[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `goldfish: cannot read bundled skills directory ${root}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  const ids = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (!ids.length) throw new Error(`goldfish: no bundled skills found in ${root}`);
  return ids.map((id) => loadSkill(root, id));
}

export async function registerSkills(ctx: PluginContext): Promise<Registration> {
  const skills = discoverSkills();
  try {
    return await ctx.skill.transform((editor) => {
      for (const skill of skills) {
        editor.add({
          id: Skill.ID.make(skill.id),
          name: Skill.Name.make(skill.name),
          description: skill.description,
          autoinvoke: skill.autoinvoke,
          path: Skill.Info.fields.path.make(skill.path),
          content: skill.content,
        } as never);
      }
    });
  } catch (error) {
    throw new Error(
      `goldfish: failed to register bundled skills: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}
