import { join } from "node:path";
import { statfsSync } from "node:fs";
import { DB } from "../shared/sqlite.js";
import {
  formatNanoTime,
  parseNanoTime,
  nowNano,
  type Signal,
} from "../shared/otlp.js";
import { digest, type Config, type Identity } from "./config.js";
export interface Batch {
  id: string;
  signal: Signal;
  table: string;
  service?: string;
  created_at: string;
  payload: Buffer;
  content_type: string;
}
export interface Queued extends Batch {
  attempts: number;
  last_error: string;
}
export interface LogCursor {
  id: string;
  offset: bigint;
  generation: bigint;
  prefix: Buffer;
  path: string;
}
export class CapacityError extends Error {
  constructor() {
    super("durable queue or receipt capacity exhausted");
  }
}
export class ConflictError extends Error {
  constructor() {
    super("batch ID conflicts with previously accepted payload");
  }
}
export function saveLogCursor(db: DB, c: LogCursor): void {
  db.run(
    "INSERT INTO log_cursors(id,offset,generation,prefix,path) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET offset=excluded.offset,generation=excluded.generation,prefix=excluded.prefix,path=excluded.path",
    c.id,
    c.offset,
    c.generation,
    c.prefix,
    c.path,
  );
}
export class Queue {
  readonly db: DB;
  constructor(readonly config: Config) {
    this.db = new DB(join(config.data_dir, "queue.sqlite"));
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,input_hash TEXT NOT NULL,forward_hash TEXT NOT NULL,agent_id TEXT NOT NULL,host_id TEXT NOT NULL,received_ns INTEGER NOT NULL,expires_ns INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,signal TEXT NOT NULL,table_name TEXT NOT NULL,service TEXT NOT NULL,created_ns INTEGER NOT NULL,payload BLOB NOT NULL,content_type TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_ns INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '',FOREIGN KEY(id) REFERENCES receipts(id));
CREATE INDEX IF NOT EXISTS batches_due ON batches(state,next_ns,created_ns);
CREATE TABLE IF NOT EXISTS queue_actions(id INTEGER PRIMARY KEY,batch_id TEXT NOT NULL,action TEXT NOT NULL,at_ns INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS log_cursors(id TEXT PRIMARY KEY,offset INTEGER NOT NULL,generation INTEGER NOT NULL,prefix BLOB NOT NULL,path TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS log_sources(id TEXT PRIMARY KEY);`);
    if (this.db.get<any>("PRAGMA quick_check")?.quick_check !== "ok") {
      this.db.close();
      throw Error("queue integrity failure");
    }
  }
  close() {
    this.db.close();
  }
  receipt(id: string):
    | {
        input_hash: string;
        forward_hash: string;
        identity: Identity;
        received_ns: bigint;
      }
    | undefined {
    const r = this.db.get<any>(
      "SELECT input_hash,forward_hash,agent_id,host_id,received_ns FROM receipts WHERE id=?",
      id,
    );
    if (r)
      return {
        input_hash: r.input_hash,
        forward_hash: r.forward_hash,
        identity: { agent_id: r.agent_id, host_id: r.host_id },
        received_ns: BigInt(r.received_ns),
      };
  }
  enqueue(
    b: Batch,
    inputHash: string,
    id: Identity,
    received: bigint,
    cursor?: LogCursor,
  ): void {
    this.db.transaction(() => {
      const old = this.receipt(b.id);
      if (old) {
        if (
          old.input_hash !== inputHash ||
          old.forward_hash !== digest(b.payload)
        )
          throw new ConflictError();
        return;
      }
      if (this.config.min_free_bytes > 0) {
        const fs = statfsSync(this.config.data_dir, { bigint: true });
        if (
          fs.bavail * fs.bsize <
          BigInt(this.config.min_free_bytes) + BigInt(b.payload.length) * 2n
        )
          throw new CapacityError();
      }
      this.db.run(
        "DELETE FROM receipts WHERE expires_ns<? AND id NOT IN (SELECT id FROM batches)",
        nowNano(),
      );
      const usage = this.db.get<any>(
        "SELECT COALESCE(SUM(LENGTH(payload)),0) AS bytes,COUNT(*) AS count FROM batches",
      )!;
      const receipts = this.db.get<any>(
        "SELECT COUNT(*) AS count FROM receipts",
      )!.count;
      if (
        BigInt(usage.bytes) + BigInt(b.payload.length) >
          BigInt(this.config.max_queue_bytes) ||
        usage.count >= this.config.max_queue_batches ||
        receipts >= this.config.max_receipts
      )
        throw new CapacityError();
      this.db.run(
        "INSERT INTO receipts VALUES(?,?,?,?,?,?,?)",
        b.id,
        inputHash,
        digest(b.payload),
        id.agent_id,
        id.host_id,
        received,
        received + BigInt(this.config.receipt_seconds) * 1000000000n,
      );
      this.db.run(
        "INSERT INTO batches(id,signal,table_name,service,created_ns,payload,content_type) VALUES(?,?,?,?,?,?,?)",
        b.id,
        b.signal,
        b.table,
        b.service ?? "",
        parseNanoTime(b.created_at),
        b.payload,
        b.content_type,
      );
      if (cursor) saveLogCursor(this.db, cursor);
    });
  }
  next(): Queued | undefined {
    const r = this.db.get<any>(
      "SELECT id,signal,table_name,service,created_ns,payload,content_type,attempts,last_error FROM batches WHERE state='pending' AND next_ns<=? ORDER BY created_ns,id LIMIT 1",
      nowNano(),
    );
    if (r)
      return {
        id: r.id,
        signal: r.signal,
        table: r.table_name,
        service: r.service,
        created_at: formatNanoTime(r.created_ns),
        payload: r.payload,
        content_type: r.content_type,
        attempts: r.attempts,
        last_error: r.last_error,
      };
  }
  complete(id: string): void {
    this.db.run("DELETE FROM batches WHERE id=?", id);
  }
  retry(id: string, error: string, next: bigint): void {
    this.db.run(
      "UPDATE batches SET attempts=attempts+1,last_error=?,next_ns=? WHERE id=?",
      error,
      next,
      id,
    );
  }
  quarantine(id: string, error: string): void {
    this.db.run(
      "UPDATE batches SET state='quarantine',attempts=attempts+1,last_error=? WHERE id=?",
      error,
      id,
    );
  }
  stats() {
    const s = this.db.get<any>(
      "SELECT COALESCE(SUM(LENGTH(payload)),0) AS bytes,COUNT(*) AS count,COALESCE(SUM(CASE WHEN state='quarantine' THEN 1 ELSE 0 END),0) AS quarantine,MIN(created_ns) AS oldest FROM batches",
    )!;
    return {
      queue_bytes: Number(s.bytes),
      queue_batches: Number(s.count),
      quarantine_batches: Number(s.quarantine),
      receipts: Number(
        this.db.get<any>("SELECT COUNT(*) AS count FROM receipts")!.count,
      ),
      oldest_age_seconds:
        s.oldest === null
          ? 0
          : Math.max(0, Number((nowNano() - BigInt(s.oldest)) / 1000000000n)),
    };
  }
  quarantined() {
    return this.db
      .all<any>(
        "SELECT id,signal,table_name,service,created_ns,last_error,LENGTH(payload) AS bytes FROM batches WHERE state='quarantine' ORDER BY created_ns LIMIT 100",
      )
      .map((r) => ({
        id: r.id,
        signal: r.signal,
        table: r.table_name,
        service: r.service,
        created_at: formatNanoTime(r.created_ns),
        error: r.last_error,
        bytes: r.bytes,
      }));
  }
  resolve(id: string, discard: boolean): void {
    this.db.transaction(() => {
      const row = this.db.get<any>("SELECT state FROM batches WHERE id=?", id);
      if (!row) throw Error("batch not found");
      if (row.state !== "quarantine") throw Error("batch is not quarantined");
      if (discard) this.db.run("DELETE FROM batches WHERE id=?", id);
      else
        this.db.run(
          "UPDATE batches SET state='pending',next_ns=0,last_error='' WHERE id=?",
          id,
        );
      this.db.run(
        "INSERT INTO queue_actions(batch_id,action,at_ns) VALUES(?,?,?)",
        id,
        discard ? "discard" : "retry",
        nowNano(),
      );
      this.db.run(
        "DELETE FROM queue_actions WHERE id NOT IN (SELECT id FROM queue_actions ORDER BY id DESC LIMIT 10000)",
      );
    });
  }
}
