import { parseJSON } from "../shared/json.js";
import type { Context, Table, QueryResponse } from "../shared/types.js";
import type { Alerts } from "./alerts.js";
import {
  allowedResponse,
  validZone,
  validatePolicyGroup,
} from "./alert-policy.js";
import {
  bytes,
  clone,
  encode,
  guarded,
  guardedAsync,
  id,
  parseTime,
  rowObject,
  stamp,
  shiftTime,
  unique,
  validRange,
} from "./common.js";
const ident = (s: string) => "`" + s.replaceAll("`", "``") + "`";
export function frameMaps(response: QueryResponse): {
  values: any[];
  truncated: boolean;
} {
  const values: any[] = [];
  let truncated = false;
  for (const r of response.results) {
    if (["error", "cancelled"].includes(r.status)) throw Error("现场查询失败");
    truncated ||= r.truncated;
    for (const f of r.frames)
      for (const row of f.rows) values.push(rowObject(f, row));
  }
  return { values, truncated };
}
export function redactSnippet(s: string): string {
  const v = s.replace(
    /(authorization|password|access[_-]?token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
    "$1=[redacted]",
  );
  return [...v].length > 500 ? [...v].slice(0, 500).join("") + "…" : v;
}
export async function validateEvidence(m: Alerts, p: any): Promise<void> {
  if (!p) return;
  const tables = await m.deps.cat.list(m.controller.signal),
    known = new Map(tables.map((t) => [t.id, t]));
  if (p.log_table_id && known.get(p.log_table_id)?.kind !== "log")
    throw Error("现场日志表必须为日志类型");
  if (
    (p.trace_table_ids?.length ?? 0) > 8 ||
    Object.keys(p.label_mappings ?? {}).length > 16 ||
    (p.lookback_seconds ?? 0) < 0 ||
    p.lookback_seconds > 3600
  )
    throw Error("现场取证范围超限");
  for (const tid of p.trace_table_ids ?? [])
    if (known.get(tid)?.kind !== "trace")
      throw Error("关联trace表必须为trace类型");
}
export async function autoEvidence(m: Alerts, r: any): Promise<void> {
  const tables = await m.deps.cat.list(m.controller.signal),
    logs = tables.filter(
      (t) =>
        t.kind === "log" &&
        (r.kind === "log"
          ? r.source_table_ids?.includes(t.id)
          : r.services?.length &&
            r.services.every((s: string) => t.services.includes(s))),
    );
  if (logs.length !== 1) return;
  let traces = tables
    .filter(
      (t) =>
        t.kind === "trace" &&
        (r.services ?? []).some((s: string) => t.services.includes(s)),
    )
    .map((t) => t.id);
  if (!r.services?.length) {
    const all = tables.filter((t) => t.kind === "trace");
    if (all.length === 1) traces = all.map((t) => t.id);
  }
  if (traces.length > 8) traces = [];
  r.evidence_profile = {
    log_table_id: logs[0].id,
    trace_table_ids: traces,
    lookback_seconds: 120,
    label_mappings: {},
  };
}
export async function collectEvidence(m: Alerts, r: any, p: any): Promise<any> {
  const e: any = {
    status: "ready",
    captured_at: stamp(m.now()),
    from: r.event.range.from,
    to: r.event.range.to,
    log_table_id: p.log_table_id,
    trace_table_ids: p.trace_table_ids ?? [],
    logs: [],
    trace_ids: [],
    truncated: false,
  };
  if (p.lookback_seconds > 0)
    e.from = shiftTime(e.from, -p.lookback_seconds * 1000);
  try {
    const table = (await m.deps.cat.list(m.controller.signal)).find(
      (t) => t.id === p.log_table_id,
    );
    if (!table) throw Error("数据表不存在");
    const has = (name: string) => table.columns.some((c) => c.name === name),
      columns = [
        "event_id",
        "event_time",
        "service",
        "severity",
        "body",
        "trace_id",
        "span_id",
        "source_id",
      ].filter(has);
    if (!columns.length) throw Error("日志表缺少现场字段");
    const where = ["$__timeFilter(event_time)"],
      params: any = {},
      rule = m.body("alert_rules", r.rule_id) ?? {},
      labels = { ...r.event.state.labels };
    if (rule.services?.length === 1) labels.service = rule.services[0];
    if (rule.services?.length > 1 && has("service")) {
      params.services = { type: "Array(String)", value: rule.services };
      where.push("service IN {services:Array(String)}");
    }
    if (
      rule.kind === "log" &&
      rule.source_table_ids?.includes(p.log_table_id)
    ) {
      if (rule.params?.alert_levels?.type === "Array(String)") {
        params.evidence_levels = rule.params.alert_levels;
        where.push("severity IN {evidence_levels:Array(String)}");
      }
      if (
        rule.params?.alert_keyword?.type === "String" &&
        rule.params.alert_keyword.value
      ) {
        params.evidence_keyword = rule.params.alert_keyword;
        where.push(
          "positionCaseInsensitiveUTF8(body,{evidence_keyword:String})>0",
        );
      }
    }
    for (const [k, v] of Object.entries(labels)) {
      const field = p.label_mappings?.[k] || k;
      if (!has(field) && !field.startsWith("attributes.")) continue;
      const name = "label_" + Object.keys(params).length;
      params[name] = { type: "String", value: v };
      if (field.startsWith("attributes.") && has("attributes_json")) {
        params[name + "_key"] = { type: "String", value: field.slice(11) };
        where.push(
          `JSONExtractString(attributes_json,{${name}_key:String})={${name}:String}`,
        );
      } else where.push(`toString(${ident(field)})={${name}:String}`);
    }
    if (
      where.length === 1 &&
      !(rule.kind === "log" && rule.source_table_ids?.includes(p.log_table_id))
    )
      return {
        ...e,
        status: "unconfigured",
        error: "需要配置service或实例标签关联，避免返回无关日志",
      };
    const order = has("severity_number")
        ? "severity_number DESC,event_time DESC"
        : "event_time DESC",
      sql = `SELECT ${columns.map(ident).join(",")} FROM ${ident(table.name)} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT 11`,
      response = await m.deps.query(
        {
          request_id: id(),
          source: "alert",
          range: { from: e.from, to: e.to },
          interval_ms: 60000,
          queries: [{ refId: "evidence", sql, params }],
        },
        AbortSignal.any([m.controller.signal, AbortSignal.timeout(2000)]),
      ),
      data = frameMaps(response);
    e.truncated = data.truncated || data.values.length > 10;
    let used = 0;
    for (const log of data.values.slice(0, 10)) {
      if (typeof log.body === "string") log.body = redactSnippet(log.body);
      const n = bytes(encode(log));
      if (used + n > 32768) {
        e.truncated = true;
        break;
      }
      used += n;
      e.logs.push(log);
      if (
        log.trace_id &&
        !e.trace_ids.includes(log.trace_id) &&
        e.trace_ids.length < 3
      )
        e.trace_ids.push(log.trace_id);
    }
    if (!e.logs.length) e.status = "empty";
  } catch (error) {
    e.status = "failed";
    e.error = (error as Error).message;
  }
  return e;
}
export async function collectPendingEvidence(m: Alerts): Promise<void> {
  const r = m.list(
    "SELECT body FROM alert_responses WHERE json_extract(body,'$.evidence.status')='pending' ORDER BY created_at LIMIT 1",
  )[0];
  if (!r) return;
  const rule = m.body("alert_rules", r.rule_id);
  if (!rule) return;
  const evidence = rule.evidence_profile
    ? await collectEvidence(m, r, rule.evidence_profile)
    : { status: "unconfigured" };
  m.deps.db.run(
    "UPDATE alert_responses SET body=json_set(body,'$.evidence',json(?)) WHERE id=? AND json_extract(body,'$.evidence.status')='pending'",
    encode(evidence),
    r.id,
  );
}
export async function traceDetail(m: Alerts, c: Context): Promise<void> {
  const trace = c.params.trace_id;
  if (!trace || bytes(trace) > 256) c.error(400, "无效的Trace ID");
  const range = {
    from: c.url.searchParams.get("from") ?? "",
    to: c.url.searchParams.get("to") ?? "",
  };
  guarded(c, () => validRange(range, 1));
  const ids = (c.url.searchParams.get("tables") ?? "").split(",");
  if (ids.length > 8 || !ids.length) c.error(400, "Trace数据表超限");
  const tables = await m.deps.cat.list(c.signal),
    spans: any[] = [];
  let truncated = false;
  for (const tid of ids) {
    const table = tables.find((t) => t.id === tid && t.kind === "trace");
    if (!table) c.error(400, "需要指定有效的Trace表");
    const cols = [
      "event_id",
      "service",
      "trace_id",
      "span_id",
      "parent_span_id",
      "name",
      "kind",
      "start_time",
      "end_time",
      "duration_ns",
      "status",
      "attributes_json",
      "events_json",
    ].filter((n) => table!.columns.some((c) => c.name === n));
    if (!cols.length) continue;
    const data = await guardedAsync(
      c,
      async () =>
        frameMaps(
          await m.deps.query(
            {
              request_id: id(),
              source: "interactive",
              range,
              interval_ms: 60000,
              queries: [
                {
                  refId: "trace",
                  sql: `SELECT ${cols.map(ident).join(",")} FROM ${ident(table!.name)} WHERE trace_id={trace_id:String} AND $__timeFilter(event_time) ORDER BY start_time,span_id LIMIT 2001`,
                  params: { trace_id: { type: "String", value: trace } },
                },
              ],
            },
            c.signal,
          ),
        ),
      502,
    );
    truncated ||= data.truncated || data.values.length > 2000;
    for (const span of data.values.slice(0, 2000))
      spans.push({ ...span, table_id: tid });
  }
  const known = new Set(spans.map((v) => v.span_id)),
    missing = spans.filter(
      (v) =>
        v.parent_span_id &&
        v.parent_span_id !== "0000000000000000" &&
        !known.has(v.parent_span_id),
    ).length;
  c.json({
    trace_id: trace,
    spans,
    truncated,
    incomplete: missing > 0 || truncated || !spans.length,
    missing_parents: missing,
    ...range,
  });
}
export async function notifyResolved(m: Alerts): Promise<void> {
  const list = m.list(
      "SELECT body FROM alert_responses WHERE state='resolved' AND json_extract(body,'$.resolution_notified')=0 ORDER BY created_at LIMIT 100",
    ),
    silences = m.list("SELECT body FROM alert_silences");
  for (const r of list) {
    if (allowedResponse(r, m.now(), silences, "")) continue;
    const g = m.group(r.group_id);
    if (!g?.enabled) continue;
    let users = m.deps.db
      .all<any>(
        "SELECT user_id FROM alert_assignments WHERE response_id=?",
        r.id,
      )
      .map((v) => v.user_id)
      .filter((key) => g.members.includes(key));
    if (r.owner_id && g.members.includes(r.owner_id)) users.push(r.owner_id);
    users = m.activeMembers(users);
    const out = m.responseTargets(
      r.group,
      ["email", "chat", "webhook", "push"],
      users,
    );
    m.deps.db.transaction(() => {
      for (const t of out.targets) {
        const payload = clone(r.event);
        payload.id = r.id + ":resolved";
        payload.message =
          "[已恢复] " +
          r.event.rule_name +
          "\n责任组 " +
          r.group_name +
          "\n" +
          r.event.message;
        const time = stamp(m.now());
        m.queue({
          id: id(),
          event_id: payload.id,
          rule_id: r.rule_id,
          group_ids: [r.group_id],
          table_ids: payload.source_table_ids ?? [],
          channel_id: t.target.channel_id,
          recipient: t.target.recipient,
          status: "queued",
          next_attempt: time,
          created_at: time,
          updated_at: time,
          payload,
          response_id: r.id,
          user_id: t.user_id || "",
          user_ids: t.user_ids,
          generation: r.generation,
          priority: r.priority,
        });
      }
      r.resolution_notified = true;
      m.saveResponse(r);
    });
  }
}
function validateProfile(p: any): void {
  p.email = String(p.email ?? "").trim();
  p.phone = String(p.phone ?? "")
    .trim()
    .replace(/[ -]/g, "");
  if (p.email && !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(p.email))
    throw Error("请输入有效的收件邮箱");
  if (/^1[3-9]\d{9}$/.test(p.phone)) p.phone = "+86" + p.phone;
  if (p.phone && !/^\+[1-9]\d{6,14}$/.test(p.phone))
    throw Error("手机号需要国家区号，例如 +8613800000000");
  p.timezone ||= "Asia/Shanghai";
  if (!validZone(p.timezone)) throw Error("无效的时区");
  for (const k of ["feishu_id", "dingtalk_id", "wecom_id"])
    if (bytes(p[k] ?? "") > 256 || /[\r\n]/.test(p[k] ?? ""))
      throw Error("无效的通知用户 ID");
}
export async function syncDirectory(m: Alerts, s: any): Promise<void> {
  const attempted = stamp(m.now());
  let error = "",
    lastSync = s.last_sync ?? "";
  try {
    const cfg = m.deps.db.get<any>(
        "SELECT secret FROM alert_directory_sources WHERE id=?",
        s.id,
      ),
      headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg?.secret)
      headers.Authorization = "Bearer " + m.deps.decrypt(cfg.secret);
    const response = await m.notifications.fetcher(s.url, {
      method: "POST",
      headers,
      body: encode({ group_id: s.group_id, at: stamp(m.now()) }),
      redirect: "error",
      signal: AbortSignal.any([m.controller.signal, AbortSignal.timeout(5000)]),
    });
    if (response.status !== 200) throw Error("目录HTTP " + response.status);
    let raw = "",
      size = 0;
    if (response.body) {
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      for (;;) {
        const p = await reader.read();
        if (p.done) break;
        size += p.value.byteLength;
        if (size > 1 << 20) {
          await reader.cancel();
          throw Error("目录响应超限");
        }
        chunks.push(p.value);
      }
      raw = Buffer.concat(chunks).toString();
    }
    const data = parseJSON(raw);
    if (!Array.isArray(data.members) || data.members.length > 100)
      throw Error("目录应返回不超过100人的members数组");
    const g = m.group(s.group_id);
    if (!g) throw Error("告警组不存在");
    const profiles = new Map<string, any>(),
      members: string[] = [];
    for (const v of data.members) {
      let uid = v.user_id;
      if (!uid && v.provider_id && v.subject)
        uid = m.deps.db.get<any>(
          "SELECT user_id FROM external_identities WHERE provider_id=? AND subject=?",
          v.provider_id,
          v.subject,
        )?.user_id;
      if (!m.member(uid)) throw Error("目录包含未知或停用用户");
      const p = { ...v.profile, user_id: uid };
      validateProfile(p);
      p.source = "directory:" + s.id;
      p.updated_at = stamp(m.now());
      members.push(uid);
      profiles.set(uid, p);
    }
    if (!members.length)
      throw Error("空目录不会清空正在使用的值班组，请在本地明确修改");
    g.members = unique(members);
    if (data.primary != null) g.primary = data.primary;
    if (data.backup != null) g.backup = data.backup;
    if (data.schedule) g.schedule = data.schedule;
    const expected = g.revision;
    g.revision++;
    validatePolicyGroup(
      g,
      (key) => m.member(key),
      (key) => m.channel(key),
    );
    m.deps.db.transaction(() => {
      const current = m.body("alert_directory_sources", s.id),
        group = m.group(g.id);
      if (current?.revision !== s.revision)
        throw Error("目录配置已变更，本次结果已丢弃");
      if (group?.revision !== expected)
        throw Error("告警组已变更，本次结果已丢弃");
      for (const [uid, p] of profiles) {
        const old = m.deps.db.get<any>(
          "SELECT body FROM user_notification_profiles WHERE user_id=?",
          uid,
        );
        if (old && parseJSON(old.body).source === "manual") continue;
        m.deps.db.run(
          "INSERT INTO user_notification_profiles(user_id,body) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET body=excluded.body",
          uid,
          encode(p),
        );
      }
      m.deps.db.run(
        "UPDATE alert_groups SET body=? WHERE id=?",
        encode(g),
        g.id,
      );
    });
    lastSync = attempted;
  } catch (e) {
    error = "目录同步失败，保留最近成功成员：" + (e as Error).message;
    throw e;
  } finally {
    m.deps.db.run(
      "UPDATE alert_directory_sources SET body=json_set(body,'$.last_attempt',?,'$.last_sync',?,'$.error',?) WHERE id=? AND coalesce(json_extract(body,'$.revision'),0)=?",
      attempted,
      lastSync,
      error,
      s.id,
      s.revision,
    );
  }
}
export async function syncDueDirectories(m: Alerts): Promise<void> {
  const list = m
    .list("SELECT body FROM alert_directory_sources")
    .sort(
      (a, b) =>
        (parseTime(a.last_attempt) || 0) - (parseTime(b.last_attempt) || 0),
    );
  let n = 0;
  for (const s of list) {
    if (
      s.enabled &&
      (!s.last_attempt ||
        m.now().getTime() - parseTime(s.last_attempt) >=
          s.interval_seconds * 1000)
    ) {
      try {
        await syncDirectory(m, s);
      } catch {}
      if (++n >= 10 || m.controller.signal.aborted) break;
    }
  }
}
export function registerDirectory(m: Alerts): void {
  const { router: r, db } = m.deps;
  r.get("/api/v1/settings/alert-directory-sources", (c) => {
    m.deps.auth.requireAdmin(c);
    c.json(m.list("SELECT body FROM alert_directory_sources"));
  });
  r.put("/api/v1/settings/alert-directory-sources/:id", async (c) => {
    m.deps.auth.requireAdmin(c);
    const v = await c.body<any>();
    guarded(c, () => {
      const u = new URL(v.url);
      if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
        throw Error("Hook需要有效HTTP(S)地址");
    });
    if (
      !v.name ||
      !Number.isInteger(v.interval_seconds) ||
      v.interval_seconds < 60 ||
      v.interval_seconds > 86400
    )
      c.error(400, "名称必填，同步间隔为60到86400秒");
    if (!m.group(v.group_id)) c.error(400, "告警组不存在");
    v.id = c.params.id;
    const old = m.body("alert_directory_sources", v.id);
    if (old && old.revision !== v.revision)
      c.error(409, "目录配置已变更，请刷新后重试");
    v.revision = (old?.revision || 0) + 1;
    for (const k of ["last_sync", "last_attempt", "error"])
      v[k] = old?.[k] || "";
    const row = db.get<any>(
        "SELECT secret FROM alert_directory_sources WHERE id=?",
        v.id,
      ),
      secret = v.token ? m.deps.encrypt(v.token) : row?.secret || "";
    delete v.token;
    v.has_token = !!secret;
    db.run(
      "INSERT INTO alert_directory_sources(id,body,secret) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,secret=excluded.secret",
      v.id,
      encode(v),
      secret,
    );
    c.json(v);
  });
  r.post("/api/v1/settings/alert-directory-sources/:id/sync", async (c) => {
    m.deps.auth.requireAdmin(c);
    const s = m.body("alert_directory_sources", c.params.id);
    if (!s) c.error(404, "目录不存在");
    await guardedAsync(c, () => syncDirectory(m, s), 502);
    c.json({ ok: true });
  });
  r.delete("/api/v1/settings/alert-directory-sources/:id", (c) => {
    m.deps.auth.requireAdmin(c);
    db.run("DELETE FROM alert_directory_sources WHERE id=?", c.params.id);
    c.json({ ok: true });
  });
}
