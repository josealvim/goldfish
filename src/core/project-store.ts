import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { dataRoot, ensureParent, legacyDbPath, projectDbPath } from "./paths.ts";
import {
  resolveProjectIdentity,
  type ProjectIdentity,
} from "./project-identity.ts";
import type { InjectionPolicy } from "./policy.ts";
import type { CloneMemoryResult } from "./relocate.ts";
import { openSqlite } from "./sqlite.ts";
import { MemoryStore } from "./store.ts";

export interface ProjectDbInfo {
  exists: boolean;
  nodes: number;
  projectId?: string;
  projectRoot?: string;
  updatedAt?: string;
  error?: string;
}

export interface ProjectDbRecord extends ProjectDbInfo {
  key: string;
  dbPath: string;
  kind: "stable" | "legacy" | "unknown";
}

export interface ResolveProjectStoreOptions {
  projectRoot: string;
  dbPath?: string;
  createIdentity?: boolean;
  dataRoot?: string;
}

export type ProjectStoreKind = "stable" | "legacy" | "explicit";

export interface ProjectStoreResolution {
  projectRoot: string;
  identity: ProjectIdentity;
  dbPath: string;
  storeKind: ProjectStoreKind;
  legacyDbPath: string;
  stableDbPath?: string;
  legacyNodes: number;
  stableNodes: number;
  legacyHasMemory: boolean;
  pendingStabilization: boolean;
  pendingAdoption: boolean;
  legacyError?: string;
  stableError?: string;
  note?: string;
}

export interface OpenProjectStoreOptions extends ResolveProjectStoreOptions {
  adopt?: boolean;
  policy?: InjectionPolicy;
}

export interface OpenedProjectStore {
  store: MemoryStore;
  resolution: ProjectStoreResolution;
  adopted?: CloneMemoryResult;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasMemory(info: ProjectDbInfo): boolean {
  return info.exists && (info.nodes > 0 || Boolean(info.error));
}

/**
 * Inspect a database without initialising or mutating its schema.
 *
 * Read-only open is preferred; some WAL databases need a writable opening to
 * recreate a missing shared-memory file, so that is the fallback.
 */
export async function inspectProjectDb(dbPath: string): Promise<ProjectDbInfo> {
  if (!existsSync(dbPath)) return { exists: false, nodes: 0 };

  let db;
  try {
    db = await openSqlite(dbPath, { readOnly: true });
  } catch {
    try {
      db = await openSqlite(dbPath);
    } catch (error) {
      return {
        exists: true,
        nodes: 0,
        error: `could not open database: ${errorMessage(error)}`,
      };
    }
  }

  try {
    let projectId: string | undefined;
    let projectRoot: string | undefined;
    try {
      const rows = db
        .prepare(
          "SELECT key, value FROM schema_meta WHERE key IN ('project_id', 'project_root')",
        )
        .all();
      for (const row of rows) {
        if (row.key === "project_id") projectId = String(row.value);
        else if (row.key === "project_root") projectRoot = String(row.value);
      }
    } catch {
      // Older databases without schema_meta are still inspectable.
    }

    let nodes = 0;
    let updatedAt: string | undefined;
    try {
      nodes = Number(db.prepare("SELECT COUNT(*) AS count FROM nodes").get()?.count ?? 0);
      const max = db.prepare("SELECT MAX(updated_at) AS updated FROM nodes").get()?.updated;
      if (typeof max === "string" && max) updatedAt = max;
    } catch {
      // A database without a nodes table is treated as empty.
    }
    if (!updatedAt) {
      try {
        updatedAt = statSync(dbPath).mtime.toISOString();
      } catch {
        // Ignore missing metadata.
      }
    }

    return {
      exists: true,
      nodes,
      ...(projectId ? { projectId } : {}),
      ...(projectRoot ? { projectRoot } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    };
  } catch (error) {
    return {
      exists: true,
      nodes: 0,
      error: `could not inspect database: ${errorMessage(error)}`,
    };
  } finally {
    db.close();
  }
}

export async function listProjectDbs(
  options: { dataRoot?: string } = {},
): Promise<ProjectDbRecord[]> {
  const root = options.dataRoot ?? dataRoot();
  const projectsDir = path.join(root, "projects");
  if (!existsSync(projectsDir)) return [];

  const records: ProjectDbRecord[] = [];
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dbPath = path.join(projectsDir, entry.name, "memory.sqlite");
    if (!existsSync(dbPath)) continue;
    const info = await inspectProjectDb(dbPath);
    const kind: ProjectDbRecord["kind"] = info.projectId
      ? "stable"
      : /^[0-9a-f]{8}$/.test(entry.name)
        ? "legacy"
        : "unknown";
    records.push({
      ...info,
      key: entry.name,
      dbPath,
      kind,
    });
  }
  records.sort((a, b) =>
    String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")),
  );
  return records;
}

/**
 * Resolve which database should serve a project.
 *
 * Legacy path-keyed databases are never abandoned automatically. When a
 * stable ID is available but the current path-keyed database holds memory,
 * the legacy DB stays active and the caller can adopt it at the next startup.
 */
export async function resolveProjectStore(
  options: ResolveProjectStoreOptions,
): Promise<ProjectStoreResolution> {
  const projectRoot = path.resolve(options.projectRoot);
  const root = options.dataRoot ?? dataRoot();
  const legacyPath = legacyDbPath(projectRoot, root);
  const legacy = await inspectProjectDb(legacyPath);
  const legacyHasMemory = hasMemory(legacy);
  const explicit = options.dbPath ?? process.env.GOLDFISH_DB;

  if (explicit) {
    const dbPath = explicit === ":memory:" ? explicit : path.resolve(explicit);
    const identity = resolveProjectIdentity(projectRoot, { create: false });
    const stableDbPath = identity.projectId ? projectDbPath(identity.projectId, root) : undefined;
    const stable = stableDbPath ? await inspectProjectDb(stableDbPath) : undefined;
    return {
      projectRoot,
      identity,
      dbPath,
      storeKind: "explicit",
      legacyDbPath: legacyPath,
      ...(stableDbPath ? { stableDbPath } : {}),
      legacyNodes: legacy.nodes,
      stableNodes: stable?.nodes ?? 0,
      legacyHasMemory,
      pendingStabilization: false,
      pendingAdoption: false,
      ...(legacy.error ? { legacyError: legacy.error } : {}),
      ...(stable?.error ? { stableError: stable.error } : {}),
      note: "database path is explicitly configured",
    };
  }

  let identity = resolveProjectIdentity(projectRoot, { create: false });

  if (
    identity.kind === "path" &&
    identity.anchor &&
    !legacyHasMemory &&
    options.createIdentity !== false
  ) {
    identity = resolveProjectIdentity(projectRoot, { create: true });
  }

  if (identity.kind === "git" && identity.projectId) {
    const stablePath = projectDbPath(identity.projectId, root);
    const stable = await inspectProjectDb(stablePath);
    const stableHasMemory = stable.exists && stable.nodes > 0;

    if (stableHasMemory) {
      const legacyNewer = Boolean(
        legacyHasMemory &&
          legacy.updatedAt &&
          stable.updatedAt &&
          legacy.updatedAt > stable.updatedAt,
      );
      return {
        projectRoot,
        identity,
        dbPath: stablePath,
        storeKind: "stable",
        legacyDbPath: legacyPath,
        stableDbPath: stablePath,
        legacyNodes: legacy.nodes,
        stableNodes: stable.nodes,
        legacyHasMemory,
        pendingStabilization: false,
        pendingAdoption: false,
        ...(legacy.error ? { legacyError: legacy.error } : {}),
        ...(stable.error ? { stableError: stable.error } : {}),
        ...(legacyNewer
          ? { note: "legacy database has newer updates than the stable database" }
          : {}),
      };
    }

    if (legacyHasMemory) {
      return {
        projectRoot,
        identity,
        dbPath: legacyPath,
        storeKind: "legacy",
        legacyDbPath: legacyPath,
        stableDbPath: stablePath,
        legacyNodes: legacy.nodes,
        stableNodes: stable.nodes,
        legacyHasMemory,
        pendingStabilization: false,
        pendingAdoption: true,
        ...(legacy.error ? { legacyError: legacy.error } : {}),
        ...(stable.error ? { stableError: stable.error } : {}),
      };
    }

    return {
      projectRoot,
      identity,
      dbPath: stablePath,
      storeKind: "stable",
      legacyDbPath: legacyPath,
      stableDbPath: stablePath,
      legacyNodes: legacy.nodes,
      stableNodes: stable.nodes,
      legacyHasMemory,
      pendingStabilization: false,
      pendingAdoption: false,
      ...(legacy.error ? { legacyError: legacy.error } : {}),
      ...(stable.error ? { stableError: stable.error } : {}),
    };
  }

  return {
    projectRoot,
    identity,
    dbPath: legacyPath,
    storeKind: "legacy",
    legacyDbPath: legacyPath,
    legacyNodes: legacy.nodes,
    stableNodes: 0,
    legacyHasMemory,
    pendingStabilization: Boolean(
      identity.anchor &&
        (legacyHasMemory || identity.reason === "stable project ID has not been created"),
    ),
    pendingAdoption: false,
    ...(legacy.error ? { legacyError: legacy.error } : {}),
  };
}

export async function openProjectStore(
  options: OpenProjectStoreOptions,
): Promise<OpenedProjectStore> {
  let resolution = await resolveProjectStore(options);

  if (options.adopt && resolution.pendingAdoption && resolution.stableDbPath) {
    let stable: MemoryStore | undefined;
    try {
      ensureParent(resolution.stableDbPath);
      stable = await MemoryStore.open({
        dbPath: resolution.stableDbPath,
        projectRoot: resolution.projectRoot,
        projectId: resolution.identity.projectId,
        ...(options.policy ? { policy: options.policy } : {}),
      });
      const adopted = stable.cloneFrom(resolution.legacyDbPath, {
        sourceProjectRoot: resolution.projectRoot,
      });
      return {
        store: stable,
        resolution: {
          ...resolution,
          dbPath: resolution.stableDbPath,
          storeKind: "stable",
          pendingAdoption: false,
          stableNodes: adopted.nodes,
          note: "legacy database adopted into the stable project ID",
        },
        adopted,
      };
    } catch (error) {
      stable?.close();
      const stableInfo = resolution.stableDbPath
        ? await inspectProjectDb(resolution.stableDbPath)
        : undefined;
      if (stableInfo && stableInfo.nodes > 0) {
        ensureParent(resolution.stableDbPath);
        const store = await MemoryStore.open({
          dbPath: resolution.stableDbPath,
          projectRoot: resolution.projectRoot,
          projectId: resolution.identity.projectId,
          ...(options.policy ? { policy: options.policy } : {}),
        });
        return {
          store,
          resolution: {
            ...resolution,
            dbPath: resolution.stableDbPath,
            storeKind: "stable",
            pendingAdoption: false,
            stableNodes: stableInfo.nodes,
            note: `stable database already contains memory; adoption skipped: ${errorMessage(error)}`,
          },
        };
      }
      ensureParent(resolution.legacyDbPath);
      const store = await MemoryStore.open({
        dbPath: resolution.legacyDbPath,
        projectRoot: resolution.projectRoot,
        ...(options.policy ? { policy: options.policy } : {}),
      });
      return {
        store,
        resolution: {
          ...resolution,
          dbPath: resolution.legacyDbPath,
          storeKind: "legacy",
          pendingAdoption: true,
          note: `stable ID adoption failed; using the legacy database: ${errorMessage(error)}`,
        },
      };
    }
  }

  ensureParent(resolution.dbPath);
  const store = await MemoryStore.open({
    dbPath: resolution.dbPath,
    projectRoot: resolution.projectRoot,
    ...(resolution.storeKind === "stable"
      ? { projectId: resolution.identity.projectId }
      : {}),
    ...(options.policy ? { policy: options.policy } : {}),
  });
  return { store, resolution };
}
