import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { shortHash } from "./ids.ts";

export function findProjectRoot(start: string = process.cwd()): string {
  let current = path.resolve(start);
  while (true) {
    if (
      exists(path.join(current, ".git")) ||
      exists(path.join(current, "opencode.json")) ||
      exists(path.join(current, "opencode.jsonc")) ||
      exists(path.join(current, "AGENTS.md"))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

function exists(target: string): boolean {
  return existsSync(target);
}

export function dataRoot(): string {
  return process.env.OPENCODE_DATA_DIR ?? path.join(homedir(), ".local", "share", "opencode");
}

export function projectKey(projectRoot: string): string {
  return shortHash(path.resolve(projectRoot));
}

/** Path-keyed database used before stable project identities. */
export function legacyDbPath(projectRoot: string, root: string = dataRoot()): string {
  return path.join(root, "projects", projectKey(projectRoot), "memory.sqlite");
}

/** Database for a stable project ID (a UUID stored in the Git worktree). */
export function projectDbPath(projectId: string, root: string = dataRoot()): string {
  return path.join(root, "projects", projectId, "memory.sqlite");
}

export function defaultDbPath(projectRoot: string): string {
  return process.env.GOLDFISH_DB ?? legacyDbPath(projectRoot);
}

export function ensureParent(target: string): void {
  if (target === ":memory:") return;
  mkdirSync(path.dirname(target), { recursive: true });
}

export function relativeTo(root: string, target: string): string {
  const relative = path.relative(root, target);
  return relative.startsWith("..") ? target : relative.split(path.sep).join("/");
}
