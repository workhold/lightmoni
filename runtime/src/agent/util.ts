import type { IncomingMessage } from "node:http";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { parseJSON, integerString, stringifyJSON } from "../shared/json.js";
import { validTable, systemTable } from "./config.js";
export class ReceiveError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function requestBytes(
  req: IncomingMessage,
  limit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit)
      throw new ReceiveError(413, "body unreadable or too large");
    chunks.push(Buffer.from(chunk));
  }
  let raw = Buffer.concat(chunks);
  const encoding = req.headers["content-encoding"];
  if (encoding && encoding !== "identity") {
    if (encoding !== "gzip")
      throw new ReceiveError(415, "unsupported Content-Encoding");
    const decompressor = createGunzip();
    const parts: Buffer[] = [];
    size = 0;
    try {
      for await (const chunk of Readable.from(raw).pipe(decompressor)) {
        size += chunk.length;
        if (size > limit) {
          decompressor.destroy();
          throw new ReceiveError(413, "decompressed batch too large");
        }
        parts.push(Buffer.from(chunk));
      }
      raw = Buffer.concat(parts);
    } catch (e) {
      if (e instanceof ReceiveError) throw e;
      throw new ReceiveError(400, "invalid gzip payload");
    }
  }
  return raw;
}
export async function responseBytes(
  response: Response,
  limit: number,
): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw Error("response too large");
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel();
  }
}
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, Math.max(1, ms));
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
export function validateSDKConfig(raw: Buffer): any {
  if (raw.length > 1 << 20) throw Error("invalid SDK configuration");
  const c = parseJSON<any>(raw.toString("utf8"));
  keys(c, ["revision", "log_sampling", "disable_rules"]);
  if (
    typeof c.revision !== "string" ||
    !c.revision ||
    Buffer.byteLength(c.revision) > 128 ||
    !c.log_sampling ||
    Array.isArray(c.log_sampling) ||
    typeof c.log_sampling !== "object" ||
    Object.keys(c.log_sampling).length > 200
  )
    throw Error("invalid SDK configuration");
  for (const [table, policy] of Object.entries(c.log_sampling)) {
    if (!validTable(table) || systemTable(table))
      throw Error("invalid log policy table");
    validatePolicy(policy);
  }
  exclusions(c.disable_rules ?? [], true);
  return c;
}
function keys(c: any, allowed: string[]) {
  if (
    !c ||
    typeof c !== "object" ||
    Array.isArray(c) ||
    Object.keys(c).some((k) => !allowed.includes(k))
  )
    throw Error("unknown reporting rule field");
}
function field(f: any): boolean {
  return (
    typeof f === "string" &&
    Buffer.byteLength(f) <= 136 &&
    !f.includes("\0") &&
    (/^(event_id|service|severity|trace_id|instance_id|sdk\.language)$/.test(
      f,
    ) ||
      /^(attr|resource):.+$/.test(f))
  );
}
function conditions(list: any, sdk = false) {
  if (!Array.isArray(list) || list.length > 8)
    throw Error("invalid conditions");
  for (const c of list) {
    keys(c, ["field", "operator", "values"]);
    if (
      !field(c.field) ||
      (sdk &&
        !["service", "instance_id", "sdk.language"].includes(c.field) &&
        !c.field.startsWith("resource:"))
    )
      throw Error("invalid rule field");
    const values = c.values ?? [];
    if (
      !Array.isArray(values) ||
      (c.operator === "exists" && values.length !== 0) ||
      (c.operator === "in" && (values.length === 0 || values.length > 256)) ||
      !["in", "exists"].includes(c.operator)
    )
      throw Error("invalid rule operator");
    for (const v of values)
      if (
        typeof v !== "string" &&
        typeof v !== "boolean" &&
        (v === null ||
          (typeof v !== "number" &&
            !(v && typeof v === "object" && v.isLosslessNumber === true)) ||
          !Number.isFinite(Number(integerString(v))))
      )
        throw Error("invalid scalar value");
  }
}
function exclusions(list: any, sdk = false) {
  if (!Array.isArray(list) || list.length > 32)
    throw Error("invalid exclusions");
  for (const r of list) {
    keys(r, ["name", "conditions"]);
    if (
      (r.name !== undefined && typeof r.name !== "string") ||
      Buffer.byteLength(r.name ?? "") > 64 ||
      !Array.isArray(r.conditions) ||
      !r.conditions.length
    )
      throw Error("invalid exclusion");
    conditions(r.conditions, sdk);
  }
}
function validatePolicy(p: any) {
  keys(p, ["key", "rules", "exclude"]);
  if (!field(p.key) || !Array.isArray(p.rules) || p.rules.length > 32)
    throw Error("invalid log policy");
  for (const r of p.rules) {
    keys(r, ["name", "rate", "conditions"]);
    if (
      (r.name !== undefined && typeof r.name !== "string") ||
      Buffer.byteLength(r.name ?? "") > 64 ||
      r.rate === undefined ||
      r.rate === null ||
      typeof r.rate !== "number" ||
      !Number.isFinite(r.rate) ||
      r.rate < 0 ||
      r.rate > 1 ||
      (r.rate > 0 && r.rate < 0.000001)
    )
      throw Error("invalid log rule");
    conditions(r.conditions);
  }
  exclusions(p.exclude ?? []);
  if (Buffer.byteLength(stringifyJSON(p)) > 64 << 10)
    throw Error("policy exceeds 64 KiB");
}
