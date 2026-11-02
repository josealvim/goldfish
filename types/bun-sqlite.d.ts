declare module "bun:sqlite" {
  export class Database {
    constructor(filename: string, options?: { create?: boolean; readonly?: boolean; readwrite?: boolean });
    exec(sql: string): void;
    prepare(sql: string): {
      run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    };
    close(): void;
  }
}
