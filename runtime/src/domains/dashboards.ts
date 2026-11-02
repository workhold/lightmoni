import { parseJSON } from "../shared/json.js";
import type { Context, Dependencies, Module } from "../shared/types.js";
import {
  bytes,
  clone,
  encode,
  guarded,
  guardedAsync,
  parseTime,
  stamp,
  uuid,
  validRange,
} from "./common.js";
import { systemDashboards } from "./system-dashboards.js";
const panelTypes = new Set([
  "line",
  "timeseries",
  "area",
  "bar",
  "pie",
  "stat",
  "table",
  "gauge",
  "heatmap",
  "histogram",
  "timeline",
]);
const relative = /^now(?:[+-][1-9][0-9]{0,6}[smhdwMy])?(?:\/[smhdwMy])?$/;
export function visibleSQL(s: string): string {
  return s.replace(
    /'(?:\\.|''|[^'])*'|"(?:\\.|""|[^"])*"|`(?:\\.|``|[^`])*`|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g,
    (m) => " ".repeat(m.length),
  );
}
export function validateQueryOptions(o: any): void {
  for (const k of ["query_interval", "query_min_interval"]) {
    if (!(k in o)) continue;
    const v = o[k];
    if (
      (k === "query_interval" && v === "auto") ||
      (k === "query_min_interval" && v === "")
    )
      continue;
    const m =
      typeof v === "string" &&
      v.trim().match(/^([1-9][0-9]*)(ms|s|m|min|h|d)$/);
    if (!m) throw Error("聚合间隔须为正整数加单位，例如 30s、1min、5min 或 1h");
    if (
      Number(m[1]) *
        (
          {
            ms: 1,
            s: 1000,
            m: 60000,
            min: 60000,
            h: 3600000,
            d: 86400000,
          } as any
        )[m[2]] >
      31536000000
    )
      throw Error("聚合间隔不能超过 365d");
  }
  if (
    "query_max_points" in o &&
    (!Number.isInteger(o.query_max_points) ||
      o.query_max_points < 1 ||
      o.query_max_points > 10000)
  )
    throw Error("最大数据点须为 1–10000 的整数");
}
export function normalizeDashboard(input: any): any {
  const d = clone(input);
  d.title = String(d.title ?? "").trim();
  if (!d.title || [...d.title].length > 160)
    throw Error("大盘名称必须为 1–160 个字符");
  d.description ??= "";
  d.panels ??= [];
  d.variables ??= [];
  d.refresh ??= 0;
  if (
    bytes(d.description) > 8000 ||
    d.panels.length > 48 ||
    d.variables.length > 16
  )
    throw Error("大盘配置超出容量限制");
  if (
    (d.rows?.length ?? 0) > 24 ||
    (d.links?.length ?? 0) > 24 ||
    (d.tags?.length ?? 0) > 32
  )
    throw Error("分组、链接或标签超出容量限制");
  for (const l of d.links ?? []) {
    let valid = false;
    try {
      const u = new URL(l.url, "http://local");
      valid =
        !/[\\\r\n]/.test(l.url) &&
        ((/^https?:\/\//.test(l.url) && !!u.hostname) ||
          (l.url.startsWith("/") && !l.url.startsWith("//")));
    } catch {}
    if (
      !l.title?.trim() ||
      bytes(l.title) > 320 ||
      bytes(l.url) > 4096 ||
      !valid
    )
      throw Error("链接需要名称与 http(s) 或站内地址");
  }
  if (
    (d.tags ?? []).some(
      (t: any) => typeof t !== "string" || !t.trim() || bytes(t) > 160,
    )
  )
    throw Error("标签无效");
  if (
    !Number.isInteger(d.refresh) ||
    (d.refresh !== 0 && d.refresh < 5) ||
    d.refresh > 3600
  )
    throw Error("刷新间隔须为 0 或 5–3600 秒");
  if (!d.range?.from) d.range = { from: "now-1h", to: "now" };
  for (const k of ["from", "to"]) {
    let s = d.range[k];
    if (/^\d{10}(?:\d{3})?$/.test(s))
      s = d.range[k] = stamp(
        new Date(Number(s) * (s.length === 10 ? 1000 : 1)),
      );
    if (
      typeof s !== "string" ||
      (!relative.test(s) && !Number.isFinite(parseTime(s)))
    )
      throw Error("时间范围需要 ISO UTC 日期或 now-1h 等相对范围");
  }
  if (
    Number.isFinite(parseTime(d.range.from)) &&
    Number.isFinite(parseTime(d.range.to))
  )
    validRange(d.range);
  const ids = new Set<string>();
  for (const [i, p] of d.panels.entries()) {
    p.id ||= uuid();
    if (ids.has(p.id)) throw Error("面板 ID 重复");
    ids.add(p.id);
    p.title = String(p.title ?? "").trim() || "新面板";
    if (!panelTypes.has(p.type)) throw Error(`未知图表类型 ${p.type}`);
    if (!p.grid?.w)
      p.grid = { x: (i % 2) * 6, y: Math.floor(i / 2) * 6, w: 6, h: 6 };
    const g = p.grid;
    if (
      !["x", "y", "w", "h"].every((k) => Number.isInteger(g[k])) ||
      g.x < 0 ||
      g.y < 0 ||
      g.w < 2 ||
      g.w > 12 ||
      g.x + g.w > 12 ||
      g.h < 3 ||
      g.h > 40
    )
      throw Error("面板布局范围无效");
    p.options ??= {};
    validateQueryOptions(p.options);
    if (!p.queries?.length || p.queries.length > 8)
      throw Error("每个面板必须包含 1–8 条查询");
    const refs = new Set<string>();
    for (const [j, q] of p.queries.entries()) {
      q.refId ||= String.fromCharCode(65 + j);
      if (refs.has(q.refId)) throw Error("面板查询 refId 重复");
      refs.add(q.refId);
      if (bytes(q.refId) > 48 || !q.sql?.trim() || bytes(q.sql) > 100000)
        throw Error("查询名称或 SQL 无效");
    }
  }
  const rowIDs = new Set<string>(),
    grouped = new Set<string>();
  for (const r of d.rows ?? []) {
    r.id ||= uuid();
    if (rowIDs.has(r.id) || !r.title?.trim() || [...r.title].length > 160)
      throw Error("分组名称无效或 ID 重复");
    rowIDs.add(r.id);
    for (const p of r.panel_ids ?? []) {
      if (!ids.has(p) || grouped.has(p))
        throw Error("分组引用了不存在或重复的面板");
      grouped.add(p);
    }
  }
  const names = new Set<string>();
  for (const v of d.variables) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/.test(v.name) || names.has(v.name))
      throw Error("变量名称无效或重复");
    names.add(v.name);
    if (!["custom", "query", "text", "constant"].includes(v.type))
      throw Error("未知变量类型");
    if (v.type === "query" && !v.sql?.trim()) throw Error("查询变量缺少 SQL");
    if (bytes(v.sql ?? "") > 100000 || (v.options?.length ?? 0) > 1000)
      throw Error("变量配置超出限制");
  }
  const active = new Set<string>(),
    visited = new Set<string>();
  const visit = (name: string) => {
    if (visited.has(name)) return;
    if (active.has(name)) throw Error(`变量依赖循环：${name}`);
    active.add(name);
    const v = d.variables.find((v: any) => v.name === name);
    for (const m of visibleSQL(v.sql ?? "").matchAll(
      /\{([a-zA-Z][a-zA-Z0-9_]*):[^}]+\}/g,
    ))
      if (names.has(m[1])) visit(m[1]);
    active.delete(name);
    visited.add(name);
  };
  for (const v of d.variables) visit(v.name);
  return d;
}
export class Dashboards implements Module {
  start(): void {
    this.seed();
  }
  constructor(readonly deps: Dependencies) {
    deps.db.exec(
      `CREATE TABLE IF NOT EXISTS dashboards(id TEXT PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL);CREATE TABLE IF NOT EXISTS dashboard_versions(dashboard_id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,updated_at TEXT NOT NULL,base_revision INTEGER NOT NULL,overwritten INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(dashboard_id,revision));CREATE TABLE IF NOT EXISTS system_dashboard_seeds(id TEXT PRIMARY KEY);`,
    );
    this.register();
    this.seed();
  }
  load(c: Context, id = c.params.id): any {
    const r = this.deps.db.get<{
      body: string;
    }>("SELECT body FROM dashboards WHERE id=?", id);
    if (!r) c.error(404, "大盘不存在");
    return parseJSON(r!.body);
  }
  insert(d: any): any {
    d = { ...d, id: uuid(), revision: 1, updated_at: stamp(this.deps.now()) };
    this.deps.db.transaction(() => {
      this.deps.db.run(
        "INSERT INTO dashboards(id,title,body,revision,updated_at) VALUES(?,?,?,?,?)",
        d.id,
        d.title,
        encode(d),
        d.revision,
        d.updated_at,
      );
      this.deps.db.run(
        "INSERT INTO dashboard_versions(dashboard_id,revision,body,updated_at,base_revision) VALUES(?,?,?,?,0)",
        d.id,
        d.revision,
        encode(d),
        d.updated_at,
      );
    });
    return d;
  }
  seed(): void {
    this.deps.db.transaction(() => {
      for (const raw of systemDashboards()) {
        if (
          this.deps.db.get(
            "SELECT id FROM system_dashboard_seeds WHERE id=?",
            raw.id,
          )
        )
          continue;
        const d = {
          ...normalizeDashboard(raw),
          revision: 1,
          updated_at: stamp(this.deps.now()),
        };
        const r = this.deps.db.run(
          "INSERT OR IGNORE INTO dashboards(id,title,body,revision,updated_at) VALUES(?,?,?,?,?)",
          d.id,
          d.title,
          encode(d),
          1,
          d.updated_at,
        );
        if (Number(r.changes) > 0)
          this.deps.db.run(
            "INSERT INTO dashboard_versions(dashboard_id,revision,body,updated_at,base_revision) VALUES(?,?,?,?,0)",
            d.id,
            1,
            encode(d),
            d.updated_at,
          );
        this.deps.db.run(
          "INSERT INTO system_dashboard_seeds(id) VALUES(?)",
          d.id,
        );
      }
    });
  }
  register(): void {
    const { router: r, db } = this.deps;
    r.get("/api/v1/dashboards", (c) =>
      c.json(
        db
          .all<{
            body: string;
          }>("SELECT body FROM dashboards ORDER BY updated_at DESC,id")
          .map((x) => parseJSON(x.body)),
      ),
    );
    r.post("/api/v1/dashboards", async (c) => {
      const input = await c.body<any>();
      c.json(this.insert(guarded(c, () => normalizeDashboard(input))), 201);
    });
    // The handlers below retain optimistic revisions and append durable version metadata.
    r.get("/api/v1/dashboards/:id", (c) => c.json(this.load(c)));
    r.get("/api/v1/dashboards/:id/versions", (c) => {
      this.load(c);
      c.json(
        db
          .all<any>(
            "SELECT revision,updated_at,base_revision,overwritten FROM dashboard_versions WHERE dashboard_id=? ORDER BY revision DESC LIMIT 100",
            c.params.id,
          )
          .map((v) => ({ ...v, overwritten: !!v.overwritten })),
      );
    });
    r.put("/api/v1/dashboards/:id", async (c) => {
      const input = await c.body<any>();
      if (!Number.isInteger(input.revision) || input.revision < 1)
        c.error(400, "更新需要 revision");
      if ((input.overwrite_revision ?? 0) < 0) c.error(400, "覆盖版本无效");
      const d = guarded(c, () => normalizeDashboard(input));
      delete d.overwrite_revision;
      d.id = c.params.id;
      const expected =
        input.overwrite_revision > 0 ? input.overwrite_revision : d.revision;
      d.revision = expected + 1;
      d.updated_at = stamp(this.deps.now());
      let changed = false;
      db.transaction(() => {
        const res = db.run(
          "UPDATE dashboards SET title=?,body=?,revision=?,updated_at=? WHERE id=? AND revision=?",
          d.title,
          encode(d),
          d.revision,
          d.updated_at,
          d.id,
          expected,
        );
        changed = Number(res.changes) > 0;
        if (changed)
          db.run(
            "INSERT INTO dashboard_versions(dashboard_id,revision,body,updated_at,base_revision,overwritten) VALUES(?,?,?,?,?,?)",
            d.id,
            d.revision,
            encode(d),
            d.updated_at,
            expected,
            input.overwrite_revision > 0 ? 1 : 0,
          );
      });
      if (!changed)
        return c.json(
          {
            error:
              "大盘已被其他成员更新，请选择保留草稿、另存副本或覆盖已显示的版本",
            code: "revision_conflict",
            current: this.load(c),
          },
          409,
        );
      c.json(d);
    });
    r.delete("/api/v1/dashboards/:id", (c) => {
      const res = db.run(
        "DELETE FROM dashboards WHERE id=? AND revision=?",
        c.params.id,
        c.url.searchParams.get("revision"),
      );
      if (!Number(res.changes)) {
        this.load(c);
        c.error(409, "大盘已更新，请重新加载后删除");
      }
      c.json({ deleted: true });
    });
    r.post("/api/v1/dashboards/:id/copy", async (c) => {
      const d = this.load(c),
        input = await c.body<any>(),
        ids = new Map<string, string>();
      d.title = input.title || d.title + " · 副本";
      for (const p of d.panels) {
        const old = p.id;
        p.id = uuid();
        ids.set(old, p.id);
      }
      for (const row of d.rows ?? []) {
        row.id = uuid();
        row.panel_ids = row.panel_ids.map((p: string) => ids.get(p));
      }
      c.json(this.insert(guarded(c, () => normalizeDashboard(d))), 201);
    });
    r.post("/api/v1/dashboards/alert-draft", async (c) => {
      const input = await c.body<any>();
      guarded(c, () => validRange(input.range));
      const refs = await guardedAsync(c, () =>
          this.deps.referencedTables(input.query.sql, c.signal),
        ),
        tables = await this.deps.cat.list(c.signal),
        ids = refs.map((name: string) => {
          const t = tables.find((t) => t.name === name);
          if (!t) c.error(400, "查询引用的表不在公开数据目录中");
          return t!.id;
        });
      if (!ids.length) c.error(400, "请选择包含监控数据表的查询");
      c.json({
        sql: input.query.sql,
        params: input.query.params,
        range: input.range,
        source_table_ids: ids,
      });
    });
  }
}
export function registerDashboards(deps: Dependencies): Dashboards {
  return new Dashboards(deps);
}
