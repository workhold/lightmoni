import { CronExpressionParser } from "cron-parser";
import type { TaskExecutionPolicy } from "../shared/task-center.js";
export type { TaskExecutionPolicy } from "../shared/task-center.js";

export interface TaskSchedule {
  mode: "continuous" | "once" | "interval" | "at" | "cron";
  interval_seconds?: number;
  run_at?: string;
  cron?: string;
  timezone?: string;
}
export const DEFAULT_TASK_POLICY: TaskExecutionPolicy = {
  max_concurrency: 10, queue_timeout_seconds: 3600, retry_count: 0, retry_delay_seconds: 60,
};
/** A normal scan is every five seconds. Older slots are missed, never backfilled. */
export const SCHEDULE_GRACE_MS = 15_000;
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const invalid = (message: string): never => { throw new Error(message); };

export function normalizeTaskSchedule(value: unknown, type: string): TaskSchedule {
  if (!record(value)) invalid("任务执行方式无效");
  const v = value as Record<string, any>;
  const fields: Record<string, string[]> = {continuous:[], once:[], interval:["interval_seconds"], at:["run_at"], cron:["cron", "timezone"]};
  if (!Object.hasOwn(fields, v.mode) || (type === "script" ? v.mode === "continuous" : v.mode !== "continuous")
    || Object.keys(v).some(key => !["mode", ...fields[v.mode]].includes(key))) invalid("任务执行方式或字段无效");
  if (v.mode === "interval") {
    if (!Number.isSafeInteger(v.interval_seconds) || v.interval_seconds < 10 || v.interval_seconds > 2_592_000)
      invalid("定时间隔必须为 10 至 2592000 秒");
    return {mode:"interval", interval_seconds:v.interval_seconds};
  }
  if (v.mode === "at") {
    const parts = typeof v.run_at === "string" && /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.exec(v.run_at);
    if (typeof v.run_at !== "string" || v.run_at.length > 40
      || !parts || +parts[2] < 1 || +parts[2] > 12 || +parts[3] < 1
      || +parts[3] > new Date(Date.UTC(+parts[1], +parts[2], 0)).getUTCDate()
      || +parts[4] > 23 || +parts[5] > 59 || +(parts[6] ?? 0) > 59
      || !Number.isFinite(Date.parse(v.run_at))) invalid("指定时间须为含时区的 ISO 时间");
    return {mode:"at", run_at:new Date(v.run_at).toISOString()};
  }
  if (v.mode === "cron") {
    if (typeof v.cron !== "string" || v.cron.length > 256 || v.cron.trim().split(/\s+/).length !== 5
      || /\bH(?:\b|\/|\()/i.test(v.cron) || /[\r\n\u0000]/.test(v.cron)) invalid("Cron 必须为五段分钟级表达式，不支持随机 H 或宏");
    if (typeof v.timezone !== "string" || !v.timezone || v.timezone.length > 100) invalid("请选择有效 IANA 时区");
    try { new Intl.DateTimeFormat("en", {timeZone:v.timezone}).format(); }
    catch { invalid("请选择有效 IANA 时区"); }
    const schedule: TaskSchedule = {mode:"cron", cron:v.cron.trim().replace(/\s+/g, " "), timezone:v.timezone};
    try { cronDates(schedule, new Date(), 1); }
    catch { invalid("Cron 表达式无效或八年内没有执行时间"); }
    return schedule;
  }
  return {mode:v.mode};
}

function cronDates(schedule: TaskSchedule, after: Date, count: number): string[] {
  // Leave enough bounded horizon for five leap-day occurrences, not just the next slot.
  const end = new Date(after); end.setUTCFullYear(end.getUTCFullYear() + Math.max(8, count * 8));
  const iterator = CronExpressionParser.parse(schedule.cron!, {tz:schedule.timezone!, currentDate:after, endDate:end});
  const result: string[] = [];
  for (let i = 0; i < count; i++) {
    if (!iterator.hasNext()) break;
    result.push(iterator.next().toDate().toISOString());
  }
  if (!result.length) invalid("Cron 表达式在八年内没有执行时间");
  return result;
}

export function nextTaskDates(schedule: TaskSchedule, after: Date, count = 5): string[] {
  if (schedule.mode === "at") return Date.parse(schedule.run_at!) > after.getTime() ? [schedule.run_at!] : [];
  if (schedule.mode === "interval") return Array.from({length:count}, (_, i) => new Date(after.getTime() + schedule.interval_seconds! * 1000 * (i + 1)).toISOString());
  if (schedule.mode === "cron") return cronDates(schedule, after, count);
  return [];
}

export function normalizeTaskPolicy(value: unknown): TaskExecutionPolicy {
  if (value == null) return {...DEFAULT_TASK_POLICY};
  if (!record(value) || Object.keys(value).some(key => !Object.hasOwn(DEFAULT_TASK_POLICY, key))) invalid("任务执行策略无效");
  const result = {...DEFAULT_TASK_POLICY, ...value};
  for (const [key, min, max] of [["max_concurrency",1,100], ["queue_timeout_seconds",10,86400], ["retry_count",0,3], ["retry_delay_seconds",10,3600]] as const)
    if (!Number.isSafeInteger(result[key]) || result[key] < min || result[key] > max) invalid("任务执行策略数值超出范围：" + key);
  return result;
}
