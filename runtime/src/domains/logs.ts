import { parseJSON } from "../shared/json.js";
import type {
  Context,
  Dependencies,
  Frame,
  Module,
  QueryRequest,
  Table,
} from "../shared/types.js";
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
  validRange,
} from "./common.js";
type Params = Record<
  string,
  {
    type: string;
    value: any;
  }
>;
export interface LogSpec {
  table_id: string;
  range: {
    from: string;
    to: string;
  };
  interval_ms?: number;
  services?: string[];
  keyword?: string;
  filters?: {
    scope?: string;
    field: string;
    type?: string;
    op: string;
    value?: any;
    disabled?: boolean;
  }[];
  sort?: string;
  mode?: string;
  sql?: string;
  params?: Params;
}
interface Session {
  id: string;
  owner: string;
  sql: string;
  base: string;
  histogramSQL: string;
  params: Params;
  range: LogSpec["range"];
  frame: Frame;
  histogram: Frame;
  interval: number;
  truncated: boolean;
  histogramTruncated: boolean;
  bytes: number;
  created: number;
  expires: number;
}
const safeName = /^[a-z][a-z0-9_]{0,80}$/;
export function logInterval(s: LogSpec): number {
  const { from, to } = validRange(s.range, 31);
  if (!s.interval_ms) return Math.max(1000, Math.floor((to - from) / 80));
  if (
    ![1000, 10000, 30000, 60000, 300000, 900000, 3600000, 86400000].includes(
      s.interval_ms,
    )
  )
    throw Error("不支持的时间桶宽度");
  if ((to - from) / s.interval_ms > 2000)
    throw Error("当前范围超过 2,000 个时间桶，请增大桶宽或缩小时间范围");
  return s.interval_ms;
}
export function freezeLogFrame(
  frame: Frame,
  budget = 8 << 20,
  limit = 2000,
): {
  frame: Frame;
  truncated: boolean;
  bytes: number;
} {
  const out: Frame = { columns: clone(frame.columns), rows: [] };
  let used = 0,
    truncated = frame.rows.length > limit;
  for (const r of frame.rows) {
    if (out.rows.length >= limit) break;
    const raw = encode(r),
      n = bytes(raw);
    if (used + n > budget) {
      truncated = true;
      break;
    }
    out.rows.push(parseJSON(raw));
    used += n;
  }
  return { frame: out, truncated, bytes: used };
}
export class Logs implements Module {
  readonly sessions = new Map<string, Session>();
  constructor(readonly deps: Dependencies) {
    deps.db.exec(
      "CREATE TABLE IF NOT EXISTS log_saved_searches(id TEXT PRIMARY KEY,title TEXT NOT NULL,spec TEXT NOT NULL,view TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL)",
    );
    this.register();
  }
  async compile(
    s: LogSpec,
    signal?: AbortSignal,
  ): Promise<{
    sql: string;
    params: Params;
    table: Table;
  }> {
    validRange(s.range, 31);
    logInterval(s);
    const table = (await this.deps.cat.list(signal)).find(
      (t) => t.id === s.table_id && t.kind === "log" && safeName.test(t.name),
    );
    if (!table) throw Error("日志表不在目录中");
    if (
      (s.filters?.length ?? 0) > 30 ||
      (s.services?.length ?? 0) > 64 ||
      bytes(s.keyword ?? "") > 1024 ||
      bytes(s.sql ?? "") > 32768
    )
      throw Error("查询条件超过限制");
    if (s.sort && !["asc", "desc"].includes(s.sort))
      throw Error("不支持的排序方向");
    const params: Params = {};
    let base = table.name;
    if (s.mode === "sql") {
      if (!s.sql?.trim()) throw Error("SQL 模式需要只读 SELECT 查询");
      const refs = await this.deps.referencedTables(s.sql, signal);
      if (refs.length !== 1 || refs[0] !== table.name)
        throw Error("日志 SQL 必须且只能引用当前日志表");
      base = "(" + s.sql + ")";
      for (const [k, v] of Object.entries(s.params ?? {})) {
        if (k.startsWith("lm_log_")) throw Error("SQL 参数名使用了保留前缀");
        params[k] = v;
      }
    } else if (s.mode && s.mode !== "filters") throw Error("未知检索模式");
    const where = ["$__timeFilter(event_time)"];
    if (s.services?.length) {
      params.lm_log_services = { type: "Array(String)", value: s.services };
      where.push("service IN {lm_log_services:Array(String)}");
    }
    if (s.keyword) {
      params.lm_log_keyword = { type: "String", value: s.keyword };
      where.push("positionCaseInsensitiveUTF8(body,{lm_log_keyword:String})>0");
    }
    const cols = Object.fromEntries(table.columns.map((c) => [c.name, c.type]));
    for (const [i, f] of (s.filters ?? []).entries()) {
      if (f.disabled) continue;
      const key = `lm_log_${i}_key`,
        value = `lm_log_${i}_value`,
        typ = f.type || "string";
      let expr = "",
        exists = "1";
      if (f.scope === "attribute") {
        if (!f.field || bytes(f.field) > 256) throw Error("属性名称无效");
        params[key] = { type: "String", value: f.field };
        exists = `JSONHas(attributes_json,{${key}:String})`;
        if (typ === "string") {
          expr = `attributes[{${key}:String}]`;
          exists += ` AND JSONType(attributes_json,{${key}:String})='String'`;
        } else if (typ === "number") {
          expr = `toFloat64OrNull(JSONExtractRaw(attributes_json,{${key}:String}))`;
          exists += ` AND JSONType(attributes_json,{${key}:String}) IN ('Int64','UInt64','Float64')`;
        } else if (typ === "boolean") {
          expr = `JSONExtractBool(attributes_json,{${key}:String})`;
          exists += ` AND JSONType(attributes_json,{${key}:String})='Bool'`;
        } else throw Error("属性过滤只支持字符串、数字和布尔值");
        if (["exists", "not_exists"].includes(f.op))
          exists = `JSONHas(attributes_json,{${key}:String})`;
      } else if (!f.scope || f.scope === "column") {
        const ct = cols[f.field];
        if (!ct || !safeName.test(f.field)) throw Error("字段不在当前表目录中");
        if (/Map|Array/.test(ct)) throw Error("复合字段请使用属性过滤");
        expr = "`" + f.field + "`";
        exists = `isNotNull(${expr})`;
        if (ct.includes("String") && typ !== "string")
          throw Error("字符串字段不能使用数字/布尔过滤");
      } else throw Error("未知字段范围");
      if (f.op === "exists") {
        where.push(`(${exists})`);
        continue;
      }
      if (f.op === "not_exists") {
        where.push(`NOT (${exists})`);
        continue;
      }
      if (["in", "not_in"].includes(f.op)) {
        if (
          typ !== "string" ||
          !Array.isArray(f.value) ||
          !f.value.length ||
          f.value.length > 64 ||
          f.value.some((v: any) => typeof v !== "string")
        )
          throw Error("多值过滤需要 1–64 个字符串值");
        params[value] = { type: "Array(String)", value: f.value };
        where.push(
          `(${exists} AND ${expr} ${f.op === "in" ? "IN" : "NOT IN"} {${value}:Array(String)})`,
        );
        continue;
      }
      const op = (
        { eq: "=", ne: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" } as any
      )[f.op];
      if (!op) throw Error("未知过滤运算符");
      if (typ !== "number" && !["eq", "ne"].includes(f.op))
        throw Error("范围比较只支持数字字段");
      let p: {
        type: string;
        value: any;
      };
      if (typ === "string") {
        if (typeof f.value !== "string" || bytes(f.value) > 4096)
          throw Error("过滤值必须是字符串");
        p = { type: "String", value: f.value };
      } else if (typ === "number") {
        const literal = String(f.value);
        if (
          !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(literal) ||
          !Number.isFinite(Number(literal))
        )
          throw Error("过滤值必须是有限数值");
        p = { type: "Float64", value: Number(literal) };
        if (f.scope === "attribute" && /^-?\d{1,29}$/.test(literal)) {
          expr = `toDecimal128OrNull(JSONExtractRaw(attributes_json,{${key}:String}),9)`;
          p = { type: "Decimal(38,9)", value: literal };
        } else if (f.scope !== "attribute" && cols[f.field].includes("Int")) {
          const unsigned = cols[f.field].includes("UInt");
          if (
            !/^-?\d+$/.test(literal) ||
            (typeof f.value === "number" && !Number.isSafeInteger(f.value))
          )
            throw Error("整数字段需要精确的 Int64/UInt64 值");
          const n = BigInt(literal);
          if (
            n < (unsigned ? 0n : -(1n << 63n)) ||
            n > (unsigned ? (1n << 64n) - 1n : (1n << 63n) - 1n)
          )
            throw Error("整数字段需要精确的 Int64/UInt64 值");
          p = { type: unsigned ? "UInt64" : "Int64", value: literal };
        }
      } else if (typ === "boolean") {
        if (typeof f.value !== "boolean") throw Error("过滤值必须是布尔值");
        p = { type: "Bool", value: f.value };
      } else throw Error("未知过滤值类型");
      params[value] = p;
      where.push(`(${exists} AND ${expr}${op}{${value}:${p.type}})`);
    }
    return {
      sql: `SELECT * FROM ${base} WHERE ${where.join(" AND ")}`,
      params,
      table,
    };
  }
  async execute(
    s: LogSpec,
    queries: QueryRequest["queries"],
    signal?: AbortSignal,
  ) {
    const out = await this.deps.query(
      {
        request_id: id(),
        source: "logs",
        range: s.range,
        interval_ms: logInterval(s),
        queries,
      },
      signal,
    );
    if (out.results.length !== queries.length) throw Error("查询结果缺少响应");
    for (const r of out.results)
      if (["error", "cancelled"].includes(r.status))
        throw Error(`查询 ${r.refId}: ${r.error ?? ""}`);
    return out.results;
  }
  keep(s: Session): void {
    let size = s.bytes;
    for (const [key, v] of this.sessions) {
      if (v.expires <= this.deps.now().getTime()) this.sessions.delete(key);
      else size += v.bytes;
    }
    while (this.sessions.size >= 32 || size > 32 << 20) {
      let oldest: Session | undefined;
      for (const v of this.sessions.values())
        if (!oldest || v.created < oldest.created) oldest = v;
      if (!oldest) break;
      size -= oldest.bytes;
      this.sessions.delete(oldest.id);
    }
    this.sessions.set(s.id, s);
  }
  async search(c: Context) {
    const req = await c.body<any>(),
      limit = req.limit || 200;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      c.error(400, "每页需要 1–1000 条");
    let s: Session | undefined,
      offset = 0;
    if (req.session_id) {
      s = this.sessions.get(req.session_id);
      if (!s || s.owner !== c.user.id || s.expires <= this.deps.now().getTime())
        c.error(410, "查询会话已过期，请保留条件重新查询");
      if (
        !/^\d+$/.test(req.cursor ?? "") ||
        Number(req.cursor) > s!.frame.rows.length
      )
        c.error(400, "无效页游标");
      offset = Number(req.cursor);
    } else {
      const spec: LogSpec = req.spec,
        b = await guardedAsync(c, () => this.compile(spec, c.signal)),
        direction = spec.sort === "asc" ? "ASC" : "DESC",
        sql = `${b.sql} ORDER BY event_time ${direction},event_id ${direction} LIMIT 2001`,
        hist = `SELECT $__timeInterval(event_time) AS time,severity,count() AS count FROM (${b.sql}) GROUP BY time,severity ORDER BY time,severity`,
        results = await guardedAsync(
          c,
          () =>
            this.execute(
              spec,
              [
                { refId: "rows", sql, params: b.params },
                { refId: "histogram", sql: hist, params: b.params },
              ],
              c.signal,
            ),
          422,
        );
      if (results[0].frames.length !== 1 || results[1].frames.length !== 1)
        c.error(502, "查询没有返回标准数据框架");
      const h = freezeLogFrame(results[1].frames[0]),
        f = freezeLogFrame(results[0].frames[0], (8 << 20) - h.bytes);
      if (
        !["event_id", "event_time", "service", "body"].every((n) =>
          f.frame.columns.some((x) => x.name === n),
        )
      )
        c.error(
          400,
          "日志 SQL 必须保留 event_id,event_time,service,body 等原始日志字段；聚合查询请使用 SQL 工作台",
        );
      const now = this.deps.now().getTime();
      s = {
        id: id(),
        owner: c.user.id,
        sql,
        base: b.sql,
        histogramSQL: hist,
        params: b.params,
        range: clone(spec.range),
        frame: f.frame,
        histogram: h.frame,
        interval: logInterval(spec),
        truncated: f.truncated || results[0].truncated,
        histogramTruncated: h.truncated || results[1].truncated,
        bytes: f.bytes + h.bytes,
        created: now,
        expires: now + 120000,
      };
      this.keep(s);
    }
    let found = !req.anchor_id;
    if (req.anchor_id && !req.session_id) {
      const n = s!.frame.rows.findIndex(
        (row) => rowObject(s!.frame, row).event_id === req.anchor_id,
      );
      if (n >= 0) {
        offset = Math.floor(n / limit) * limit;
        found = true;
      }
    }
    const end = Math.min(s!.frame.rows.length, offset + limit);
    c.json({
      frame: {
        columns: s!.frame.columns,
        rows: s!.frame.rows.slice(offset, end),
      },
      histogram: s!.histogram,
      histogram_truncated: s!.histogramTruncated,
      session_id: s!.id,
      next_cursor: end < s!.frame.rows.length ? String(end) : "",
      total_loaded: s!.frame.rows.length,
      truncated: s!.truncated,
      expires_at: stamp(new Date(s!.expires)),
      generated_at: stamp(new Date(s!.created)),
      range: s!.range,
      sql: s!.sql,
      count_sql: `SELECT count() AS value FROM (${s!.base})`,
      histogram_sql: s!.histogramSQL,
      params: s!.params,
      interval_ms: s!.interval,
      scope: "bounded_session; histogram_independent_range_aggregation",
      anchor_found: found,
    });
  }
  async aggregate(c: Context) {
    const req = await c.body<any>(),
      spec: LogSpec = req.spec,
      b = await guardedAsync(c, () => this.compile(spec, c.signal)),
      limit = req.limit || 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      c.error(400, "Top 值数量需为 1–50");
    let expr = "",
      present = "1",
      kind = "'String'";
    if (req.field?.startsWith("attr:")) {
      const key = req.field.slice(5);
      if (!key || bytes(key) > 256) c.error(400, "属性名称无效");
      b.params.lm_log_agg_field = { type: "String", value: key };
      expr = "JSONExtractRaw(attributes_json,{lm_log_agg_field:String})";
      present = "JSONHas(attributes_json,{lm_log_agg_field:String})";
      kind = "toString(JSONType(attributes_json,{lm_log_agg_field:String}))";
    } else {
      const col = b.table.columns.find(
        (x: any) =>
          x.name === req.field &&
          safeName.test(x.name) &&
          !/Map|Array/.test(x.type),
      );
      if (!col) c.error(400, "此字段不支持聚合");
      expr = "toString(`" + col!.name + "`)";
      present = "isNotNull(`" + col!.name + "`)";
      if (/Int|Float|Decimal/.test(col!.type)) kind = "'Number'";
    }
    const sql = `SELECT ${expr} AS value,${kind} AS value_type,count() AS count FROM (${b.sql}) WHERE ${present} GROUP BY value,value_type ORDER BY count DESC,value ASC LIMIT ${limit}`,
      countSQL = `SELECT count() AS total,countIf(${present}) AS present FROM (${b.sql})`,
      out = await guardedAsync(
        c,
        () =>
          this.execute(
            spec,
            [
              { refId: "groups", sql, params: b.params },
              { refId: "totals", sql: countSQL, params: b.params },
            ],
            c.signal,
          ),
        422,
      );
    if (out[0].frames.length !== 1 || out[1].frames.length !== 1)
      c.error(502, "聚合没有返回标准数据框架");
    const f = freezeLogFrame(out[0].frames[0], 1 << 20, 50),
      tot = out[1].frames[0],
      t = tot.rows[0]
        ? rowObject(tot, tot.rows[0])
        : { total: "0", present: "0" };
    c.json({
      frame: f.frame,
      field: req.field,
      total: t.total,
      present: t.present,
      truncated: f.truncated || out[0].truncated,
      generated_at: stamp(this.deps.now()),
      scope: "independent_complete_range_aggregation",
      sql,
      params: b.params,
      range: spec.range,
    });
  }
  async detail(c: Context) {
    const spec: LogSpec = {
        table_id: c.params.table,
        range: {
          from: c.url.searchParams.get("from") ?? "",
          to: c.url.searchParams.get("to") ?? "",
        },
      },
      b = await guardedAsync(c, () => this.compile(spec, c.signal));
    b.params.lm_log_event = { type: "String", value: c.params.event };
    const rr = await guardedAsync(
      c,
      () =>
        this.execute(
          spec,
          [
            {
              refId: "event",
              sql: b.sql + " AND event_id={lm_log_event:String} LIMIT 1",
              params: b.params,
            },
          ],
          c.signal,
        ),
      422,
    );
    if (!rr[0].frames[0]?.rows.length)
      c.error(404, "日志未保留或不在当前时间范围内");
    c.json({ frame: rr[0].frames[0] });
  }
  async context(c: Context) {
    const req = await c.body<any>();
    if (!req.event_id) c.error(400, "缺少上下文锚点");
    const s: LogSpec = {
        ...req.spec,
        mode: "filters",
        filters: [],
        services: [],
        keyword: "",
      },
      b = await guardedAsync(c, () => this.compile(s, c.signal));
    b.params.lm_log_event = { type: "String", value: req.event_id };
    const rr = await guardedAsync(
        c,
        () =>
          this.execute(
            s,
            [
              {
                refId: "anchor",
                sql: b.sql + " AND event_id={lm_log_event:String} LIMIT 1",
                params: b.params,
              },
            ],
            c.signal,
          ),
        422,
      ),
      f = rr[0].frames[0];
    if (!f?.rows.length) c.error(404, "上下文锚点未保留");
    const anchor = rowObject(f, f.rows[0]);
    if (typeof anchor.source_id !== "string" || !anchor.source_id)
      c.error(400, "该日志没有可靠来源标识");
    b.params.lm_log_source = { type: "String", value: anchor.source_id };
    b.params.lm_log_service = { type: "String", value: String(anchor.service) };
    b.params.lm_log_time = { type: "String", value: String(anchor.event_time) };
    let field = "event_time",
      value = "parseDateTime64BestEffort({lm_log_time:String},9)",
      mode = "event_time";
    if (anchor.source_seq !== null && anchor.source_seq !== undefined) {
      field = "source_seq";
      value = "{lm_log_seq:UInt64}";
      mode = "source_seq";
      b.params.lm_log_seq = {
        type: "UInt64",
        value: String(anchor.source_seq),
      };
    }
    const limit = req.limit > 0 ? req.limit : 25;
    if (limit > 100 || !Number.isInteger(limit))
      c.error(400, "每侧上下文最多 100 条");
    const scope =
        b.sql +
        " AND source_id={lm_log_source:String} AND service={lm_log_service:String}",
      before = `${scope} AND (${field},event_id)<(${value},{lm_log_event:String}) ORDER BY ${field} DESC,event_id DESC LIMIT ${limit}`,
      after = `${scope} AND (${field},event_id)>(${value},{lm_log_event:String}) ORDER BY ${field} ASC,event_id ASC LIMIT ${limit}`,
      out = await guardedAsync(
        c,
        () =>
          this.execute(
            s,
            [
              { refId: "before", sql: before, params: b.params },
              { refId: "after", sql: after, params: b.params },
            ],
            c.signal,
          ),
        422,
      );
    c.json({
      frame: {
        columns: f.columns,
        rows: [
          ...(out[0].frames[0]?.rows ?? []).slice().reverse(),
          f.rows[0],
          ...(out[1].frames[0]?.rows ?? []),
        ],
      },
      source_id: anchor.source_id,
      order: mode,
      anchor_id: req.event_id,
      limit_per_side: limit,
      scope: "同表同来源；关键词、级别与属性过滤已移除；保留当前时间范围",
    });
  }
  async tail(c: Context) {
    const req = await c.body<any>(),
      s: LogSpec = req.spec;
    if (s.mode === "sql")
      c.error(400, "SQL 模式使用手动刷新；实时支持结构化检索");
    const now = this.deps.now(),
      since = parseTime(req.since);
    if (!Number.isFinite(since) || since > now.getTime())
      c.error(400, "无效实时时间游标");
    if (now.getTime() - since > 120000)
      c.error(409, "实时连接间隔超过 2 分钟，请完整重新查询");
    const b = await guardedAsync(c, () => this.compile(s, c.signal));
    b.params.lm_log_since = {
      type: "String",
      value: shiftTime(req.since, -15000),
    };
    b.params.lm_log_until = { type: "String", value: stamp(now) };
    const sql =
        b.sql +
        " AND ingested_at>=parseDateTime64BestEffort({lm_log_since:String},9) AND ingested_at<parseDateTime64BestEffort({lm_log_until:String},9) ORDER BY ingested_at ASC,event_id ASC LIMIT 2001",
      out = await guardedAsync(
        c,
        () =>
          this.execute(s, [{ refId: "tail", sql, params: b.params }], c.signal),
        422,
      );
    if (out[0].frames.length !== 1) c.error(502, "实时查询没有返回 frame");
    const f = freezeLogFrame(out[0].frames[0]);
    c.json({
      frame: f.frame,
      next_since: stamp(now),
      truncated: f.truncated || out[0].truncated,
      overlap_seconds: 15,
      scope: "接收时间重叠 15 秒；查询可见延迟超过窗口时需要历史重查",
    });
  }
  saved(c: Context, key = c.params.id): any {
    const row = this.deps.db.get<any>(
      "SELECT * FROM log_saved_searches WHERE id=?",
      key,
    );
    if (!row) c.error(404, "保存检索不存在");
    return { ...row, spec: parseJSON(row.spec), view: parseJSON(row.view) };
  }
  async writeSaved(c: Context, update: boolean) {
    const s = await c.body<any>();
    s.title = String(s.title ?? "").trim();
    if (!s.title || bytes(s.title) > 240) c.error(400, "名称需要 1–240 字节");
    await guardedAsync(c, () => this.compile(s.spec, c.signal));
    if (bytes(encode(s.view ?? null)) > 65536) c.error(400, "显示配置超过限制");
    s.updated_at = stamp(this.deps.now());
    if (update) {
      if (!Number.isInteger(s.revision) || s.revision < 1)
        c.error(400, "修改需要 revision");
      s.id = c.params.id;
      const r = this.deps.db.run(
        "UPDATE log_saved_searches SET title=?,spec=?,view=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",
        s.title,
        encode(s.spec),
        encode(s.view ?? null),
        s.updated_at,
        s.id,
        s.revision,
      );
      if (!Number(r.changes)) {
        this.saved(c);
        c.error(409, "检索已被其他成员修改，请重新打开后保存");
      }
      s.revision++;
    } else {
      s.id = id();
      s.revision = 1;
      this.deps.db.run(
        "INSERT INTO log_saved_searches(id,title,spec,view,revision,updated_at) VALUES(?,?,?,?,1,?)",
        s.id,
        s.title,
        encode(s.spec),
        encode(s.view ?? null),
        s.updated_at,
      );
    }
    c.json(s);
  }
  register(): void {
    const r = this.deps.router;
    r.post("/api/v1/logs/search", (c) => this.search(c));
    r.post("/api/v1/logs/aggregate", (c) => this.aggregate(c));
    r.post("/api/v1/logs/context", (c) => this.context(c));
    r.post("/api/v1/logs/tail", (c) => this.tail(c));
    r.get("/api/v1/logs/:table/events/:event", (c) => this.detail(c));
    r.get("/api/v1/logs/saved-searches", (c) =>
      c.json(
        this.deps.db
          .all<any>("SELECT * FROM log_saved_searches ORDER BY updated_at DESC")
          .map((row) => ({
            ...row,
            spec: parseJSON(row.spec),
            view: parseJSON(row.view),
          })),
      ),
    );
    r.get("/api/v1/logs/saved-searches/:id", (c) => c.json(this.saved(c)));
    r.post("/api/v1/logs/saved-searches", (c) => this.writeSaved(c, false));
    r.put("/api/v1/logs/saved-searches/:id", (c) => this.writeSaved(c, true));
    r.delete("/api/v1/logs/saved-searches/:id", (c) => {
      if (
        !Number(
          this.deps.db.run(
            "DELETE FROM log_saved_searches WHERE id=?",
            c.params.id,
          ).changes,
        )
      )
        c.error(404, "保存检索不存在");
      c.json({ ok: true });
    });
  }
  close(): void {
    this.sessions.clear();
  }
}
export function registerLogs(deps: Dependencies): Logs {
  return new Logs(deps);
}
