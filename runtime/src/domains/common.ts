import { parseJSON, stringifyJSON } from "../shared/json.js";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import type { Context, Dependencies, Frame } from "../shared/types.js";
export const id = () => randomBytes(16).toString("hex");
export const uuid = () => randomUUID();
export const encode = (v: any) => stringifyJSON(v);
export const clone = <T>(v: T): T => parseJSON(encode(v));
export const hash = (v: string) => createHash("sha256").update(v).digest("hex");
export const bytes = (v: string) => Buffer.byteLength(v);
export const stamp = (d: Date) =>
  d.toISOString().replace(/\.(\d{3})Z$/, ".$1000000Z");
export function parseTime(s: unknown): number {
  if (typeof s !== "string") return NaN;
  const m = s.match(
    /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,9})?(?:Z|[+-](\d\d):(\d\d))$/,
  );
  if (!m) return NaN;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number),
    leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0),
    days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    Number(m[7] || 0) > 23 ||
    Number(m[8] || 0) > 59
  )
    return NaN;
  return Date.parse(s);
}
export function timeNanos(s: unknown): bigint {
  if (typeof s !== "string" || !Number.isFinite(parseTime(s)))
    throw Error("无效的 RFC3339 时间");
  const fraction = s.match(/\.(\d{1,9})(?:Z|[+-]\d\d:\d\d)$/)?.[1] ?? "";
  const seconds = Date.parse(s.replace(/\.\d{1,9}(?=Z|[+-]\d\d:\d\d$)/, ""));
  return BigInt(seconds) * 1000000n + BigInt(fraction.padEnd(9, "0"));
}
export function nanoStamp(n: bigint): string {
  let seconds = n / 1000000000n,
    fraction = n % 1000000000n;
  if (fraction < 0) {
    seconds--;
    fraction += 1000000000n;
  }
  return (
    new Date(Number(seconds * 1000n)).toISOString().slice(0, 19) +
    "." +
    fraction.toString().padStart(9, "0") +
    "Z"
  );
}
export const normalizeStamp = (s: string) => nanoStamp(timeNanos(s));
export const shiftTime = (s: string, milliseconds: number) =>
  nanoStamp(timeNanos(s) + BigInt(milliseconds) * 1000000n);
export const unique = <T>(a: T[]) => [...new Set(a)];
export const rowObject = (f: Frame, r: any[]) =>
  Object.fromEntries(f.columns.map((c, i) => [c.name, r[i]]));
export const bodies = (d: Dependencies, sql: string, ...params: any[]): any[] =>
  d.db
    .all<{
      body: string;
    }>(sql, ...params)
    .map((r) => parseJSON(r.body));
export function invalid(c: Context, message: string): never {
  return c.error(400, message);
}
export function requireValue(
  c: Context,
  value: any,
  message: string,
  status = 400,
): asserts value {
  if (!value) c.error(status, message);
}
export function validRange(
  range: any,
  maxDays = Infinity,
): {
  from: number;
  to: number;
} {
  let a: bigint, b: bigint;
  try {
    a = timeNanos(range?.from);
    b = timeNanos(range?.to);
  } catch {
    throw Error("结束时间必须晚于开始时间，且时间须为带时区的 RFC3339 格式");
  }
  if (a >= b)
    throw Error("结束时间必须晚于开始时间，且时间须为带时区的 RFC3339 格式");
  if (Number.isFinite(maxDays) && b - a > BigInt(maxDays * 86400000) * 1000000n)
    throw Error(`单次查询最多 ${maxDays} 天，请缩小时间范围`);
  return { from: parseTime(range.from), to: parseTime(range.to) };
}
export function guarded(c: Context, fn: () => any, status = 400): any {
  try {
    return fn();
  } catch (e) {
    c.error(status, (e as Error).message);
  }
}
export async function guardedAsync(
  c: Context,
  fn: () => Promise<any>,
  status = 400,
): Promise<any> {
  try {
    return await fn();
  } catch (e) {
    if ((e as any).status) throw e;
    c.error(status, (e as Error).message);
  }
}
