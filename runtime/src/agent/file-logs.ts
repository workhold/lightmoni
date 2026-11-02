import {
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readdirSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { encodeOTLP, formatNanoTime, nowNano } from "../shared/otlp.js";
import {
  glob,
  digest,
  logSourceID,
  type RemoteConfig,
  type Identity,
} from "./config.js";
import { Queue, saveLogCursor, type Batch, type LogCursor } from "./queue.js";
interface File {
  fd: number;
  path: string;
  source: string;
  idle: number;
}
export interface LogAgent {
  queue: Queue;
  identity: Identity;
  config: { max_batch_bytes: number };
  accept(b: Batch, owned: boolean, cursor?: LogCursor): void;
}
export class FileLogReader {
  readonly files = new Map<string, File>();
  constructor(readonly agent: LogAgent) {}
  close() {
    for (const f of this.files.values()) closeSync(f.fd);
    this.files.clear();
  }
  poll(tasks: RemoteConfig, signal?: AbortSignal): void {
    if (!tasks.logs_enabled) {
      this.close();
      return;
    }
    const active = new Set(tasks.log_sources.map(logSourceID)),
      seen = new Set<string>(),
      failures: string[] = [];
    for (const [id, file] of this.files)
      if (!active.has(file.source)) {
        closeSync(file.fd);
        this.files.delete(id);
      }
    for (const source of tasks.log_sources) {
      if (signal?.aborted) return;
      const sourceID = logSourceID(source),
        initialized = this.agent.queue.db.get<any>(
          "SELECT COUNT(*) AS count FROM log_sources WHERE id=?",
          sourceID,
        )!.count;
      let entries = 0;
      const matcher = glob(source.pattern);
      const walk = (path: string) => {
        if (signal?.aborted) throw Error("cancelled");
        if (++entries > 10000)
          throw Error("directory scan exceeds 10000 entries");
        const info = lstatSync(path, { bigint: true });
        if (path === source.directory && !info.isDirectory())
          throw Error("configured log path is not a directory");
        if (info.isDirectory()) {
          if (path !== source.directory && !source.recursive) return;
          for (const name of readdirSync(path)) walk(join(path, name));
          return;
        }
        if (
          info.isSymbolicLink() ||
          !info.isFile() ||
          !matcher.test(basename(path)) ||
          /\.(gz|zip)$/i.test(path)
        )
          return;
        const fileID = digest(`${info.dev}:${info.ino}`),
          id = digest(this.agent.identity.host_id + "\0" + fileID);
        seen.add(id);
        const existing = this.files.get(id);
        if (existing) {
          existing.path = path;
          return;
        }
        if (this.files.size >= 256)
          throw Error("file log collection exceeds 256 open files");
        const fd = openSync(path, "r");
        try {
          const opened = fstatSync(fd, { bigint: true }),
            current = lstatSync(path, { bigint: true });
          if (
            !sameFile(info, opened) ||
            !sameFile(current, opened) ||
            !current.isFile() ||
            !opened.isFile()
          )
            throw Error("log file changed during discovery");
          const exists = this.agent.queue.db.get<any>(
            "SELECT COUNT(*) AS count FROM log_cursors WHERE id=?",
            id,
          )!.count;
          if (!exists)
            saveLogCursor(this.agent.queue.db, {
              id,
              path,
              prefix: prefix(fd, 64),
              offset:
                initialized === 0 && !source.from_beginning ? opened.size : 0n,
              generation: 0n,
            });
          this.files.set(id, { fd, path, source: sourceID, idle: 0 });
        } catch (e) {
          closeSync(fd);
          throw e;
        }
      };
      try {
        walk(source.directory);
        this.agent.queue.db.run(
          "INSERT OR IGNORE INTO log_sources(id) VALUES(?)",
          sourceID,
        );
      } catch (e) {
        failures.push(source.directory + ": " + (e as Error).message);
      }
    }
    let budget = 8 << 20;
    for (const [id, file] of this.files) {
      if (budget <= 0 || signal?.aborted) break;
      try {
        const consumed = this.read(id, file, tasks, Math.min(budget, 1 << 20));
        budget -= consumed;
        file.idle = consumed === 0 ? file.idle + 1 : 0;
        if (!seen.has(id) && file.idle >= 3) {
          closeSync(file.fd);
          this.files.delete(id);
        }
      } catch (e) {
        failures.push(file.path + ": " + (e as Error).message);
      }
    }
    if (failures.length) throw Error(failures.join("; "));
  }
  private read(
    id: string,
    file: File,
    tasks: RemoteConfig,
    budget: number,
  ): number {
    const old = this.agent.queue.db.get<any>(
      "SELECT offset,generation,prefix FROM log_cursors WHERE id=?",
      id,
    );
    if (!old) throw Error("missing log checkpoint");
    const cursor: LogCursor = {
        id,
        path: file.path,
        offset: BigInt(old.offset),
        generation: BigInt(old.generation),
        prefix: old.prefix,
      },
      info = fstatSync(file.fd, { bigint: true });
    if (
      info.size < cursor.offset ||
      !prefix(file.fd, cursor.prefix.length).equals(cursor.prefix)
    ) {
      cursor.offset = 0n;
      cursor.generation++;
    }
    cursor.prefix = prefix(file.fd, 64);
    const lineLimit = Math.max(
        1,
        Math.min(64 << 10, Math.floor(this.agent.config.max_batch_bytes / 4)),
      ),
      buffer = Buffer.alloc(budget),
      size = readSync(file.fd, buffer, 0, budget, cursor.offset as any);
    let pos = 0;
    const start = cursor.offset,
      records: any[] = [];
    const request = () => ({
      resourceLogs: [
        {
          resource: {
            attributes: [
              str("service.name", "lightmoni-agent"),
            ],
          },
          scopeLogs: [
            { scope: { name: "lightmoni.file-logs" }, logRecords: records },
          ],
        },
      ],
    });
    while (records.length < 256 && pos < size) {
      const newline = buffer.indexOf(10, pos),
        complete =
          newline >= pos && newline < size && newline - pos + 1 <= lineLimit,
        fragment = !complete && size - pos >= lineLimit;
      if (!complete && !fragment) break;
      let consumed = complete ? newline - pos + 1 : lineLimit,
        body = buffer.subarray(pos, pos + consumed);
      if (fragment) {
        let end = body.length;
        for (
          let n = 0;
          n < 3 && end > 0 && !validUTF8(body.subarray(0, end));
          n++
        )
          end--;
        if (validUTF8(body.subarray(0, end))) {
          body = body.subarray(0, end);
          consumed = end;
        }
      } else {
        body = body.subarray(0, body.length - 1);
        if (body.at(-1) === 13) body = body.subarray(0, body.length - 1);
      }
      const attributes = [
        str("file_path", file.path),
        str("file_name", basename(file.path)),
        str("event_time_source", "observed"),
        str("lightmoni.source_id", `${id}:${cursor.generation}`),
        {
          key: "lightmoni.source_seq",
          value: { intValue: cursor.offset.toString() },
        },
      ];
      if (fragment)
        attributes.push({
          key: "log_fragment",
          value: { boolValue: true },
        } as any);
      records.push({
        observedTimeUnixNano: nowNano().toString(),
        body: { stringValue: body.toString("utf8") },
        attributes,
      });
      if (
        records.length > 1 &&
        encodeOTLP("logs", request()).length + 512 >
          this.agent.config.max_batch_bytes
      ) {
        records.pop();
        break;
      }
      cursor.offset += BigInt(consumed);
      pos += consumed;
      if (
        cursor.offset - start >=
          BigInt(Math.floor(this.agent.config.max_batch_bytes / 2)) ||
        fragment
      )
        break;
    }
    if (!records.length) {
      saveLogCursor(this.agent.queue.db, cursor);
      return 0;
    }
    this.agent.accept(
      {
        id: randomUUID(),
        signal: "logs",
        table: tasks.log_table,
        service: "lightmoni-agent",
        created_at: formatNanoTime(nowNano()),
        payload: encodeOTLP("logs", request()),
        content_type: "application/x-protobuf",
      },
      true,
      cursor,
    );
    return Number(cursor.offset - start);
  }
}
function sameFile(a: BigIntStats, b: BigIntStats) {
  return a.dev === b.dev && a.ino === b.ino;
}
function prefix(fd: number, size: number): Buffer {
  const buffer = Buffer.alloc(size),
    count = readSync(fd, buffer, 0, size, 0);
  return buffer.subarray(0, count);
}
const decoder = new TextDecoder("utf8", { fatal: true });
function validUTF8(value: Uint8Array) {
  try {
    decoder.decode(value);
    return true;
  } catch {
    return false;
  }
}
function str(key: string, value: string) {
  return { key, value: { stringValue: value } };
}
