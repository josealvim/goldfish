import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { transaction, type SqliteDatabase } from "./sqlite.ts";

export interface CloneMemoryOptions {
  dbPath: string;
  projectRoot: string;
  projectId?: string;
  sourceDbPath: string;
  sourceProjectRoot?: string;
  dryRun?: boolean;
  now?: () => Date;
}

export interface CloneMemoryCounts {
  nodes: number;
  versions: number;
  sources: number;
  citations: number;
  edges: number;
  events: number;
  injections: number;
  audits: number;
  feedback: number;
  conflictProposals: number;
}

export interface CloneMemoryResult extends CloneMemoryCounts {
  adopted: boolean;
  dryRun: boolean;
  sourceDbPath: string;
  sourceProjectRoot?: string;
}

const COPY_TABLES = [
  ["nodes", "nodes"],
  ["node_versions", "versions"],
  ["sources", "sources"],
  ["citations", "citations"],
  ["edges", "edges"],
  ["events", "events"],
  ["injections", "injections"],
  ["audits", "audits"],
  ["feedback", "feedback"],
  ["conflict_proposals", "conflictProposals"],
] as const;

function tableExists(db: SqliteDatabase, schema: "main" | "source", table: string): boolean {
  return Boolean(
    db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`).get(table),
  );
}

function tableColumns(db: SqliteDatabase, schema: "main" | "source", table: string): string[] {
  return db
    .prepare(`PRAGMA ${schema}.table_info(${table})`)
    .all()
    .map((row) => String(row.name));
}

function countTable(db: SqliteDatabase, schema: "main" | "source", table: string): number {
  if (!tableExists(db, schema, table)) return 0;
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${schema}.${table}`).get()?.count ?? 0);
}

function counts(db: SqliteDatabase, schema: "main" | "source"): CloneMemoryCounts {
  const result = {} as CloneMemoryCounts;
  for (const [table, key] of COPY_TABLES) {
    result[key] = countTable(db, schema, table);
  }
  return result;
}

function quotePath(target: string): string {
  return target.replace(/'/g, "''");
}

function sameFile(left: string, right: string): boolean {
  try {
    return realpathSync.native(left) === realpathSync.native(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

function tagsText(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string").join(" ")
      : "";
  } catch {
    return "";
  }
}

function rebuildFts(db: SqliteDatabase): void {
  db.exec("DELETE FROM main.nodes_fts;");
  const rows = db.prepare("SELECT id, title, body, tags_json FROM main.nodes").all();
  const insert = db.prepare(
    "INSERT INTO main.nodes_fts(node_id, title, body, tags) VALUES(?, ?, ?, ?)",
  );
  for (const row of rows) {
    insert.run(
      String(row.id),
      String(row.title),
      String(row.body),
      tagsText(row.tags_json),
    );
  }
}

/**
 * Copy all memory tables from another SQLite database into this store.
 *
 * The copy uses SQLite ATTACH and a single transaction instead of replacing
 * database files. That is safe while an OpenCode plugin holds the target
 * connection open: readers keep their snapshot and writers serialize normally.
 */
export function cloneMemoryInto(
  db: SqliteDatabase,
  options: CloneMemoryOptions,
): CloneMemoryResult {
  const sourceDbPath = path.resolve(options.sourceDbPath);
  if (!existsSync(sourceDbPath)) {
    throw new Error(`No memory database found at ${sourceDbPath}`);
  }
  if (options.dbPath !== ":memory:" && sameFile(options.dbPath, sourceDbPath)) {
    throw new Error("The source and target memory databases are the same file.");
  }

  db.exec(`ATTACH DATABASE '${quotePath(sourceDbPath)}' AS source;`);
  try {
    const sourceCounts = counts(db, "source");
    const targetCount = countTable(db, "main", "nodes");
    if (options.dryRun) {
      return {
        ...sourceCounts,
        adopted: false,
        dryRun: true,
        sourceDbPath,
        ...(options.sourceProjectRoot ? { sourceProjectRoot: options.sourceProjectRoot } : {}),
      };
    }
    if (targetCount > 0) {
      throw new Error(
        `Target database already contains ${targetCount} memory node${targetCount === 1 ? "" : "s"}.`,
      );
    }

    const result = transaction(db, () => {
      db.exec("PRAGMA defer_foreign_keys = ON;");
      const racedCount = countTable(db, "main", "nodes");
      if (racedCount > 0) {
        throw new Error(
          `Target database already contains ${racedCount} memory node${racedCount === 1 ? "" : "s"}.`,
        );
      }

      for (const [table] of COPY_TABLES) {
        if (!tableExists(db, "source", table) || !tableExists(db, "main", table)) continue;
        const sourceColumns = new Set(tableColumns(db, "source", table));
        const columns = tableColumns(db, "main", table).filter((column) =>
          sourceColumns.has(column),
        );
        if (!columns.length) continue;
        const list = columns.map((column) => `"${column}"`).join(", ");
        db.exec(
          `INSERT INTO main."${table}" (${list}) SELECT ${list} FROM source."${table}"`,
        );
      }

      rebuildFts(db);

      const now = (options.now ?? (() => new Date()))().toISOString();
      const setMeta = db.prepare(
        `INSERT INTO main.schema_meta(key, value) VALUES(?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      );
      setMeta.run("project_root", options.projectRoot);
      if (options.projectId) setMeta.run("project_id", options.projectId);
      setMeta.run("relocated_from", options.sourceProjectRoot ?? sourceDbPath);
      setMeta.run("relocated_at", now);

      const copiedCounts = counts(db, "main");
      db.prepare(
        "INSERT INTO main.events(ts, actor_json, action, node_id, payload_json) VALUES(?, ?, ?, ?, ?)",
      ).run(
        now,
        JSON.stringify({ type: "system", id: "stabilize" }),
        "project_adopted",
        null,
        JSON.stringify({
          sourceDbPath,
          sourceProjectRoot: options.sourceProjectRoot,
          counts: copiedCounts,
        }),
      );
      return copiedCounts;
    });

    return {
      ...result,
      adopted: true,
      dryRun: false,
      sourceDbPath,
      ...(options.sourceProjectRoot ? { sourceProjectRoot: options.sourceProjectRoot } : {}),
    };
  } finally {
    try {
      db.exec("DETACH DATABASE source;");
    } catch {
      // Ignore detach failures; the transaction has already committed or
      // rolled back, and the connection will be closed by the caller.
    }
  }
}
