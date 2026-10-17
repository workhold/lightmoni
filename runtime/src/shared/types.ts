import type { IncomingMessage, ServerResponse } from "node:http";
import type { DB } from "./sqlite.js";
export type JSONValue = any;
export interface User {
  id: string;
  name: string;
  role: string;
  nickname?: string;
  avatar_url?: string;
}
export interface Context {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  url: URL;
  user: User;
  signal: AbortSignal;
  body<T = any>(): Promise<T>;
  raw(limit?: number): Promise<Buffer>;
  json(value: any, status?: number): void;
  error(status: number, message: string): never;
}
export type Handler = (ctx: Context) => unknown | Promise<unknown>;
export interface Router {
  get(path: string, handler: Handler, options?: { public?: boolean }): void;
  post(path: string, handler: Handler, options?: { public?: boolean }): void;
  put(path: string, handler: Handler, options?: { public?: boolean }): void;
  delete(path: string, handler: Handler, options?: { public?: boolean }): void;
  patch(path: string, handler: Handler, options?: { public?: boolean }): void;
}
export interface Column {
  name: string;
  type: string;
  nullable?: boolean;
}
export interface Frame {
  name?: string;
  columns: Column[];
  rows: any[][];
  meta?: Record<string, any>;
}
export interface QueryRequest {
  request_id?: string;
  source?: string;
  range: { from: string; to: string };
  interval_ms: number;
  queries: {
    refId: string;
    sql: string;
    params?: Record<string, { type: string; value: any }>;
  }[];
}
export interface QueryResponse {
  request_id: string;
  results: {
    refId: string;
    status: string;
    frames: Frame[];
    complete: boolean;
    truncated: boolean;
    elapsed_ms: number;
    error?: string;
  }[];
}
export interface Table {
  id: string;
  name: string;
  logical_name: string;
  kind: string;
  metric_type?: string;
  columns: Column[];
  services: string[];
  system: boolean;
  alert_group_id?: string;
  retention_days: number | null;
  effective_retention_days: number;
}
export interface WriteKey {
  id: string;
  name: string;
  allowed_tables: string[];
  allow_all_tables: boolean;
}
export interface ClickHouse {
  exec(sql: string, signal?: AbortSignal): Promise<void>;
  query(
    sql: string,
    params?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{
    meta: { name: string; type: string }[];
    data: Record<string, any>[];
    rows: number;
  }>;
  insert(
    table: string,
    rows: Record<string, any>[],
    signal?: AbortSignal,
  ): Promise<void>;
}
export interface Catalog {
  list(signal?: AbortSignal): Promise<Table[]>;
  ensure?(table: string, kind: string, metricType?: string): Promise<any>;
}
export interface Auth {
  requireAdmin(ctx: Context): void;
  user(req: IncomingMessage): User | undefined;
  validateKey(ctx: Context, table?: string): WriteKey;
  master: Buffer;
}
export interface Dependencies {
  db: DB;
  router: Router;
  query: (
    request: QueryRequest,
    signal?: AbortSignal,
  ) => Promise<QueryResponse>;
  referencedTables: (sql: string, signal?: AbortSignal) => Promise<string[]>;
  cat: Catalog;
  ch: ClickHouse;
  reader: ClickHouse;
  auth: Auth;
  externalURL: string;
  encrypt: (value: string) => string;
  decrypt: (value: string) => string;
  now: () => Date;
  logger: {
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
  };
}
export interface Module {
  start?(): void | Promise<void>;
  close?(): void | Promise<void>;
}
export type { DB } from "./sqlite.js";
