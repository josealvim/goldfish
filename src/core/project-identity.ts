import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { shortHash } from "./ids.ts";

/**
 * A stable project anchor inside a Git worktree.
 *
 * The private git dir is used instead of the common git dir so linked
 * worktrees keep their own memory. The relative path keeps nested project
 * roots distinct inside one repository.
 */
export interface GitProjectAnchor {
  gitDir: string;
  toplevel: string;
  relativePath: string;
  idPath: string;
}

export type ProjectIdentityKind = "git" | "path";

export interface ProjectIdentity {
  projectRoot: string;
  projectKey: string;
  kind: ProjectIdentityKind;
  projectId?: string;
  anchor?: GitProjectAnchor;
  reason?: string;
}

export interface ProjectIdReadResult {
  id?: string;
  error?: string;
}

export interface ProjectIdEnsureResult extends ProjectIdReadResult {
  created: boolean;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canonical(target: string): string {
  try {
    return realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

function git(root: string, args: string[]): string | undefined {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve the Git worktree anchor for a project root.
 *
 * Returns undefined when Git is unavailable, the root is not inside a
 * worktree, or the worktree cannot be inspected. Callers then fall back to the
 * legacy path-derived key.
 */
export function gitProjectAnchor(projectRoot: string): GitProjectAnchor | undefined {
  const root = canonical(projectRoot);
  const toplevelRaw = git(root, ["rev-parse", "--show-toplevel"]);
  const gitDirRaw =
    git(root, ["rev-parse", "--absolute-git-dir"]) ?? git(root, ["rev-parse", "--git-dir"]);
  if (!toplevelRaw || !gitDirRaw) return undefined;

  const toplevel = canonical(toplevelRaw);
  const gitDir = canonical(path.resolve(root, gitDirRaw));
  const relative = path.relative(toplevel, root);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return undefined;
  }

  const normalized = (relative || ".").split(path.sep).join("/");
  const hashInput = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  return {
    gitDir,
    toplevel,
    relativePath: normalized,
    idPath: path.join(gitDir, "goldfish", "projects", shortHash(hashInput), "id"),
  };
}

export function readProjectId(anchor: GitProjectAnchor): ProjectIdReadResult {
  try {
    const value = readFileSync(anchor.idPath, "utf8").trim();
    if (!value) return { error: `stable project ID file is empty: ${anchor.idPath}` };
    if (!UUID_PATTERN.test(value)) {
      return { error: `stable project ID file is invalid: ${anchor.idPath}` };
    }
    return { id: value };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return { error: `could not read ${anchor.idPath}: ${errorMessage(error)}` };
  }
}

/**
 * Read the stable ID, creating it atomically when it does not exist.
 *
 * `writeFileSync(..., { flag: "wx" })` makes concurrent first opens agree on a
 * single ID: the loser reads the winner's file instead of overwriting it.
 */
export function ensureProjectId(anchor: GitProjectAnchor): ProjectIdEnsureResult {
  const existing = readProjectId(anchor);
  if (existing.id) return { ...existing, created: false };
  if (existing.error) return { ...existing, created: false };

  try {
    mkdirSync(path.dirname(anchor.idPath), { recursive: true });
    const id = randomUUID();
    writeFileSync(anchor.idPath, `${id}\n`, { encoding: "utf8", flag: "wx" });
    return { id, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const raced = readProjectId(anchor);
      return raced.id
        ? { ...raced, created: false }
        : { ...raced, created: false, error: raced.error ?? "could not read the stable project ID" };
    }
    return {
      created: false,
      error: `could not write ${anchor.idPath}: ${errorMessage(error)}`,
    };
  }
}

/**
 * Resolve a project's stable identity.
 *
 * With `create: false`, this is a pure read: an existing ID is returned, but a
 * missing one is reported instead of written. The project-store resolver uses
 * that to avoid stabilising a legacy database without an explicit command.
 */
export function resolveProjectIdentity(
  projectRoot: string,
  options: { create?: boolean } = {},
): ProjectIdentity {
  const root = path.resolve(projectRoot);
  const projectKey = shortHash(root);
  const anchor = gitProjectAnchor(root);
  if (!anchor) {
    return {
      projectRoot: root,
      projectKey,
      kind: "path",
      reason: "not a Git worktree",
    };
  }

  const existing = readProjectId(anchor);
  if (existing.id) {
    return {
      projectRoot: root,
      projectKey,
      kind: "git",
      projectId: existing.id,
      anchor,
    };
  }
  if (existing.error) {
    return {
      projectRoot: root,
      projectKey,
      kind: "path",
      anchor,
      reason: existing.error,
    };
  }
  if (!options.create) {
    return {
      projectRoot: root,
      projectKey,
      kind: "path",
      anchor,
      reason: "stable project ID has not been created",
    };
  }

  const ensured = ensureProjectId(anchor);
  if (ensured.id) {
    return {
      projectRoot: root,
      projectKey,
      kind: "git",
      projectId: ensured.id,
      anchor,
    };
  }
  return {
    projectRoot: root,
    projectKey,
    kind: "path",
    anchor,
    reason: ensured.error ?? "could not create a stable project ID",
  };
}
