import { clone, parseTime, stamp, unique } from "./common.js";
export const priority = (v: string) =>
  ["P0", "P1", "P2", "P3"].includes(v) ? v : v === "critical" ? "P0" : "P2";
export const priorityRank = (v: string) =>
  ["P0", "P1", "P2", "P3"].indexOf(priority(v));
export function defaultPolicies(): any {
  return {
    P0: {
      methods: ["voice", "sms"],
      repeat_seconds: 120,
      backup_after_seconds: 300,
      fallback_after_seconds: 600,
      max_rounds: 6,
      handling_seconds: 1800,
    },
    P1: {
      methods: ["voice", "sms"],
      start: "09:00",
      end: "22:00",
      night_mode: "after_count",
      night_methods: ["voice"],
      night_after_count: 3,
      repeat_seconds: 300,
      backup_after_seconds: 600,
      fallback_after_seconds: 1200,
      max_rounds: 6,
      handling_seconds: 3600,
    },
    P2: {
      methods: ["sms"],
      start: "09:00",
      end: "22:00",
      repeat_seconds: 1800,
      max_rounds: 6,
      handling_seconds: 7200,
    },
    P3: {
      methods: ["email", "webhook"],
      start: "09:00",
      end: "18:00",
      weekdays: [1, 2, 3, 4, 5],
      repeat_seconds: 3600,
      max_rounds: 1,
    },
  };
}
export function legacyPolicies(): any {
  const p = defaultPolicies();
  p.P0.methods = ["voice", "sms", "chat"];
  p.P1 = {
    methods: ["sms", "chat"],
    start: "09:00",
    end: "22:00",
    repeat_seconds: 300,
    backup_after_seconds: 600,
    fallback_after_seconds: 1200,
    max_rounds: 6,
    handling_seconds: 3600,
  };
  p.P2 = {
    methods: ["email", "webhook", "chat"],
    start: "09:00",
    end: "22:00",
    repeat_seconds: 1800,
    escalate_after_rounds: 3,
    escalate_to: "P1",
    max_rounds: 6,
    handling_seconds: 7200,
  };
  return p;
}
export function fillLegacyPolicies(g: any): any {
  if (g.members?.length) g.policies = { ...legacyPolicies(), ...g.policies };
  return g;
}
export const policy = (g: any, p: string) =>
  g.policies?.[p] ?? legacyPolicies()[priority(p)];
export function validZone(z: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z }).format();
    return true;
  } catch {
    return false;
  }
}
export function localParts(at: Date, zone: string): any {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const p = Object.fromEntries(
    parts
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  );
  const day = Date.UTC(p.year, p.month - 1, p.day);
  return {
    ...p,
    weekday: new Date(day).getUTCDay(),
    calendar: day,
    date: `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`,
  };
}
export function zonedDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  zone: string,
): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  let instant = target;
  for (let i = 0; i < 4; i++) {
    const p = localParts(new Date(instant), zone),
      visible = Date.UTC(
        p.year,
        p.month - 1,
        p.day,
        p.hour,
        p.minute,
        p.second,
      ),
      delta = target - visible;
    if (!delta) break;
    instant += delta;
  }
  return new Date(instant);
}
export function clockMinutes(s: string): number {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw Error("时间必须使用 HH:mm");
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}
export function windowAllowed(
  now: Date,
  zone: string,
  start = "",
  end = "",
  days: number[] = [],
): boolean {
  if (!validZone(zone)) return false;
  const n = localParts(now, zone),
    minute = n.hour * 60 + n.minute;
  if (!start && !end) return !days?.length || days.includes(n.weekday);
  let a: number, b: number;
  try {
    a = clockMinutes(start);
    b = clockMinutes(end);
  } catch {
    return false;
  }
  let day = n.weekday;
  if (a > b && minute < b) day = (day + 6) % 7;
  if (days?.length && !days.includes(day)) return false;
  if (a === b) return true;
  return a < b ? minute >= a && minute < b : minute >= a || minute < b;
}
export function onCall(
  g: any,
  now: Date,
): {
  primary: string[];
  backup: string[];
} {
  const s = g.schedule ?? {},
    zone = s.timezone || g.timezone || "UTC";
  let shift = { primary: g.primary ?? [], backup: g.backup ?? [] };
  if (s.shifts?.length) {
    let idx = 0;
    if (s.mode !== "fixed") {
      const a = localParts(new Date(parseTime(s.anchor)), zone),
        n = localParts(now, zone),
        days =
          s.mode === "weekly"
            ? 7
            : s.mode === "daily"
              ? 1
              : Math.max(1, s.interval_days || 1);
      let delta = Math.round((n.calendar - a.calendar) / 86400000);
      if (
        n.hour * 3600 + n.minute * 60 + n.second <
        a.hour * 3600 + a.minute * 60 + a.second
      )
        delta--;
      idx = delta >= 0 ? Math.floor(delta / days) % s.shifts.length : -1;
    }
    shift = idx >= 0 ? s.shifts[idx] : { primary: [], backup: [] };
  }
  for (const o of s.overrides ?? [])
    if (
      now.getTime() >= parseTime(o.from) &&
      now.getTime() < parseTime(o.until)
    )
      shift = o;
  const filter = (a: string[]) =>
    unique(a ?? []).filter((x) => x && g.members?.includes(x));
  return { primary: filter(shift.primary), backup: filter(shift.backup) };
}
export function nightPeriod(r: any, now: Date): string {
  const p = policy(r.group, r.priority);
  if (
    !p.start ||
    !p.end ||
    p.start === p.end ||
    !windowAllowed(now, r.group.timezone, p.end, p.start, p.weekdays)
  )
    return "";
  let n = localParts(now, r.group.timezone);
  const end = clockMinutes(p.end);
  if (n.hour * 60 + n.minute < end) {
    const d = new Date(n.calendar - 86400000);
    n = {
      ...n,
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
    };
  }
  return (
    r.priority +
    ":" +
    stamp(
      zonedDate(
        n.year,
        n.month,
        n.day,
        Math.floor(end / 60),
        end % 60,
        0,
        r.group.timezone,
      ),
    )
  );
}
export function notificationMethods(r: any, now: Date): string[] {
  const p = policy(r.group, r.priority);
  return nightPeriod(r, now) &&
    ["immediate", "after_count"].includes(p.night_mode)
    ? p.night_methods
    : (p.methods ?? []);
}
export function silenceMatches(s: any, r: any): boolean {
  if (s.priorities?.length && !s.priorities.includes(r.priority)) return false;
  for (const [k, v] of Object.entries(s.labels ?? {}))
    if (r.event.state.labels?.[k] !== v) return false;
  return (
    s.scope === "all" ||
    (s.scope === "group" && s.group_id === r.group_id) ||
    (s.scope === "rule" && s.rule_id === r.rule_id) ||
    (s.scope === "incident" && s.response_id === r.id) ||
    (s.scope === "service" &&
      s.service &&
      s.service === r.event.state.labels?.service)
  );
}
export function silenceActive(s: any, now: Date): boolean {
  const n = now.getTime();
  if (
    (Number.isFinite(parseTime(s.from)) && n < parseTime(s.from)) ||
    (Number.isFinite(parseTime(s.until)) && n >= parseTime(s.until))
  )
    return false;
  return (
    !s.daily_start ||
    windowAllowed(now, s.timezone, s.daily_start, s.daily_end, s.weekdays)
  );
}
export function allowedResponse(
  r: any,
  now: Date,
  silences: any[],
  ruleSilence = "",
): string {
  if (parseTime(ruleSilence) > now.getTime()) return "规则静默";
  for (const s of silences)
    if (silenceMatches(s, r) && silenceActive(s, now))
      return "静默：" + s.reason;
  const p = policy(r.group, r.priority);
  if (!windowAllowed(now, r.group.timezone, p.start, p.end, p.weekdays)) {
    const period = nightPeriod(r, now);
    if (period) {
      if (p.night_mode === "immediate") return "";
      if (p.night_mode === "after_count") {
        if (
          r.night_period === period &&
          r.night_count >= p.night_after_count &&
          r.night_eligible_at &&
          now.getTime() >= parseTime(r.night_eligible_at)
        )
          return "";
        return `夜间仅记录：持续告警 ${r.night_period === period ? r.night_count || 0 : 0}/${p.night_after_count} 轮`;
      }
    }
    return "通知窗口外";
  }
  return "";
}
export function responseActiveSeconds(
  r: any,
  from: number,
  to: number,
  silences: any[],
  ruleSilence = "",
): number {
  if (!Number.isFinite(from) || to <= from) return 0;
  const bounds = new Set<number>([from, to]);
  for (let n = Math.floor(from / 60000) * 60000 + 60000; n < to; n += 60000)
    bounds.add(n);
  for (const s of silences)
    for (const v of [s.from, s.until]) {
      const n = parseTime(v);
      if (n > from && n < to) bounds.add(n);
    }
  for (const v of [ruleSilence, r.night_eligible_at]) {
    const n = parseTime(v);
    if (n > from && n < to) bounds.add(n);
  }
  const list = [...bounds].sort((a, b) => a - b);
  let seconds = 0;
  for (let i = 1; i < list.length; i++)
    if (!allowedResponse(r, new Date(list[i - 1]), silences, ruleSilence))
      seconds += (list[i] - list[i - 1]) / 1000;
  return seconds;
}
export function validatePolicyGroup(
  g: any,
  member: (id: string) => any,
  channel: (id: string) => any,
): void {
  g.timezone ||= "Asia/Shanghai";
  if (!validZone(g.timezone)) throw Error("无效的时区");
  g.members = unique((g.members ?? []).filter(Boolean));
  if (g.members.length > 100) throw Error("告警组最多100名成员");
  if (!g.members.length) return;
  if (!g.channel_ids?.length) throw Error("请选择系统通知接入");
  for (const u of g.members)
    if (!member(u)) throw Error(`无效或停用的组成员：${u}`);
  const users = (a: string[]) => {
    for (const u of a ?? [])
      if (!g.members.includes(u)) throw Error(`值班人员必须是告警组成员：${u}`);
  };
  for (const a of [g.primary, g.backup, g.fallback]) users(a);
  const s = (g.schedule ??= {});
  s.timezone ||= g.timezone;
  s.mode ||= "fixed";
  if (!validZone(s.timezone)) throw Error("无效的时区");
  if (!["fixed", "daily", "weekly", "custom"].includes(s.mode))
    throw Error("无效的排班周期");
  if (
    s.mode !== "fixed" &&
    (!Number.isFinite(parseTime(s.anchor)) || !s.shifts?.length)
  )
    throw Error("周期排班需要起点和班次");
  if (
    s.mode === "custom" &&
    (!Number.isInteger(s.interval_days) ||
      s.interval_days < 1 ||
      s.interval_days > 365)
  )
    throw Error("自定义班次周期为1到365天");
  if ((s.shifts?.length ?? 0) > 52 || (s.overrides?.length ?? 0) > 100)
    throw Error("排班数量超限");
  for (const v of s.shifts ?? []) {
    users(v.primary);
    users(v.backup);
  }
  for (const [i, o] of (s.overrides ?? []).entries()) {
    if (
      !Number.isFinite(parseTime(o.from)) ||
      parseTime(o.until) <= parseTime(o.from)
    )
      throw Error("替班时间无效");
    users(o.primary);
    users(o.backup);
    for (const other of s.overrides.slice(0, i))
      if (
        parseTime(o.from) < parseTime(other.until) &&
        parseTime(o.until) > parseTime(other.from)
      )
        throw Error("替班时间不能重叠");
  }
  for (const [key, p] of Object.entries<any>(g.policies ?? {})) {
    if (priority(key) !== key) throw Error("策略级别为P0至P3");
    for (const m of [...(p.methods ?? []), ...(p.night_methods ?? [])])
      if (!["email", "sms", "voice", "chat", "webhook", "push"].includes(m))
        throw Error("无效的通知方式");
    if (
      p.night_mode &&
      !["silent", "immediate", "after_count"].includes(p.night_mode)
    )
      throw Error("夜间策略为仅记录、直接通知或累计后通知");
    if (p.night_after_count < 0 || p.night_after_count > 1000)
      throw Error("夜间持续告警轮数必须为1到1000");
    if (
      ["immediate", "after_count"].includes(p.night_mode) &&
      (!p.start ||
        !p.end ||
        p.start === p.end ||
        !p.night_methods?.length ||
        (p.night_mode === "after_count" && !(p.night_after_count >= 1)))
    )
      throw Error("夜间通知需要日间时段、有效轮数和夜间通知方式");
    if (p.start || p.end) {
      clockMinutes(p.start);
      clockMinutes(p.end);
    }
    if ((p.weekdays ?? []).some((d: number) => d < 0 || d > 6))
      throw Error("无效的星期");
    if (
      p.repeat_seconds < 10 ||
      p.repeat_seconds > 86400 ||
      p.max_rounds < 1 ||
      p.max_rounds > 30 ||
      (p.handling_seconds ?? 0) < 0 ||
      p.handling_seconds > 604800 ||
      (p.backup_after_seconds ?? 0) < 0 ||
      (p.fallback_after_seconds ?? 0) < 0 ||
      (p.escalate_after_rounds ?? 0) < 0
    )
      throw Error("通知间隔至少10秒，轮次1到30，处理期限不超过7天");
    if (
      p.escalate_after_rounds > 0 &&
      (priority(p.escalate_to) !== p.escalate_to ||
        priorityRank(p.escalate_to) >= priorityRank(key))
    )
      throw Error("升级目标必须为更高优先级");
  }
  for (const cid of g.channel_ids)
    if (!channel(cid)) throw Error("通知接入不存在");
  if (!g.primary?.length && !s.shifts?.length)
    throw Error("至少配置固定主班或周期班次");
}
