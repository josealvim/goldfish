export type SqlValue = string | number | null | bigint | Uint8Array;

export interface SqliteRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  run(...params: SqlValue[]): SqliteRunResult;
  get(...params: SqlValue[]): Record<string, unknown> | undefined;
  all(...params: SqlValue[]): Array<Record<string, unknown>>;
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

function wrapBun(db: {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): SqliteRunResult;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
}): SqliteDatabase {
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const statement = db.prepare(sql);
      return {
        run: (...params) => statement.run(...params),
        get: (...params) => statement.get(...params) as Record<string, unknown> | undefined,
        all: (...params) => statement.all(...params) as Array<Record<string, unknown>>,
      };
    },
    close: () => db.close(),
  };
}

function wrapNode(db: {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): SqliteRunResult;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
}): SqliteDatabase {
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const statement = db.prepare(sql);
      return {
        run: (...params) => statement.run(...params),
        get: (...params) => statement.get(...params) as Record<string, unknown> | undefined,
        all: (...params) => statement.all(...params) as Array<Record<string, unknown>>,
      };
    },
    close: () => db.close(),
  };
}

/**
 * Open SQLite on either runtime OpenCode may use.
 *
 * The OpenCode server is Bun-based, so `bun:sqlite` is the primary binding.
 * The CLI and tests run on Node, where `node:sqlite` is built in from Node 22.
 * Keeping this adapter small means the core does not depend on either runtime.
 */
export async function openSqlite(filename: string): Promise<SqliteDatabase> {
  try {
    const bun = await import("bun:sqlite");
    const db = new bun.Database(filename);
    db.exec("PRAGMA busy_timeout = 5000;");
    return wrapBun(db as never);
  } catch {
    // Fall through to Node's built-in SQLite.
  }

  try {
    const node = await import("node:sqlite");
    const db = new node.DatabaseSync(filename);
    db.exec("PRAGMA busy_timeout = 5000;");
    return wrapNode(db as never);
  } catch (error) {
    throw new Error(
      `Unable to open SQLite. OpenCode should provide bun:sqlite; Node 22+ provides node:sqlite. ${String(error)}`,
    );
  }
}

export function transaction<T>(db: SqliteDatabase, callback: () => T): T {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const result = callback();
    db.exec("COMMIT;");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Ignore rollback failures and surface the original error.
    }
    throw error;
  }
}
