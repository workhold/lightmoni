import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
const exact = (value: any): any =>
  typeof value === "bigint"
    ? value <= BigInt(Number.MAX_SAFE_INTEGER) &&
      value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString()
    : value instanceof Uint8Array
      ? Buffer.from(value)
      : value;
const bind = (value: any): SQLInputValue =>
  value === undefined || value === null
    ? null
    : typeof value === "boolean"
      ? Number(value)
      : value instanceof Uint8Array
        ? value
        : typeof value === "object"
          ? JSON.stringify(value)
          : value;
export class DB {
  readonly native: DatabaseSync;
  constructor(readonly path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.native = new DatabaseSync(path);
    try {
      // Apply the timeout before the WAL transition, which can race on first open.
      this.native.exec(
        "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
      );
      if (path !== ":memory:") chmodSync(path, 0o600);
    } catch (error) {
      this.native.close();
      throw error;
    }
  }
  exec(sql: string): void {
    this.native.exec(sql);
  }
  run(
    sql: string,
    ...params: any[]
  ): { changes: number; lastInsertRowid: number | bigint } {
    const result = this.native.prepare(sql).run(...params.map(bind));
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid,
    };
  }
  get<T = Record<string, any>>(sql: string, ...params: any[]): T | undefined {
    const statement = this.native.prepare(sql);
    statement.setReadBigInts(true);
    const row = statement.get(...params.map(bind));
    return row
      ? (Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key, exact(value)]),
        ) as T)
      : undefined;
  }
  all<T = Record<string, any>>(sql: string, ...params: any[]): T[] {
    const statement = this.native.prepare(sql);
    statement.setReadBigInts(true);
    return statement
      .all(...params.map(bind))
      .map(
        (row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [key, exact(value)]),
          ) as T,
      );
  }
  transaction<T>(fn: () => T): T {
    this.native.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      if (result && typeof (result as any).then === "function")
        throw Error("SQLite transactions must not span await");
      this.native.exec("COMMIT");
      return result;
    } catch (error) {
      this.native.exec("ROLLBACK");
      throw error;
    }
  }
  close(): void {
    this.native.close();
  }
}
