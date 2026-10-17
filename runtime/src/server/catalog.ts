import type { Table, Column, ClickHouse as CH } from "../shared/types.js";
import { DB } from "../shared/sqlite.js";
import { Serial } from "../shared/serial.js";
import { validTable, systemTable } from "./auth.js";
const common =
  "event_id String,event_time DateTime64(9,'UTC'),ingested_at DateTime64(9,'UTC'),service LowCardinality(String),instance_id String,host_id String,agent_id String,key_id String,resource_json String,attributes Map(String,String),attributes_json String";
const quote = (s: string) => "`" + s.replace(/`/g, "``") + "`";
export class Catalog {
  private serial = new Serial();
  constructor(
    readonly db: DB,
    readonly ch: CH & { user?: string },
    readonly reader: CH & { user?: string },
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS catalog(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,logical_name TEXT NOT NULL,kind TEXT NOT NULL,metric_type TEXT NOT NULL,columns_json TEXT NOT NULL,services_json TEXT NOT NULL DEFAULT '[]',alert_group_id TEXT NOT NULL DEFAULT ''); CREATE TABLE IF NOT EXISTS ingest_batches(id TEXT PRIMARY KEY,digest TEXT NOT NULL,first_received_at TEXT NOT NULL,key_id TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 0);CREATE TABLE IF NOT EXISTS retention_config(id INTEGER PRIMARY KEY CHECK(id=1),default_days INTEGER NOT NULL); INSERT OR IGNORE INTO retention_config(id,default_days) VALUES(1,7);CREATE TABLE IF NOT EXISTS log_sampling(logical_name TEXT PRIMARY KEY,policy_json TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1); CREATE TABLE IF NOT EXISTS sdk_reporting(id INTEGER PRIMARY KEY CHECK(id=1),disable_rules TEXT NOT NULL); INSERT OR IGNORE INTO sdk_reporting VALUES(1,'[]');",
    );
    db.transaction(() => {
      if (
        !db
          .all<any>("PRAGMA table_info(catalog)")
          .some((c) => c.name === "retention_days")
      )
        db.exec(
          "ALTER TABLE catalog ADD COLUMN retention_days INTEGER; UPDATE catalog SET retention_days=30 WHERE kind='metric'",
        );
    });
  }
  defaultRetention() {
    return this.db.get<any>(
      "SELECT default_days FROM retention_config WHERE id=1",
    )!.default_days as number;
  }
  async list(_signal?: AbortSignal): Promise<Table[]> {
    return this.db
      .all<any>(
        "SELECT *,COALESCE(retention_days,(SELECT default_days FROM retention_config WHERE id=1)) effective_retention_days FROM catalog ORDER BY name",
      )
      .map(({ columns_json, services_json, ...row }) => ({
        ...row,
        columns: JSON.parse(columns_json),
        services: JSON.parse(services_json),
        system: systemTable(row.logical_name),
      }));
  }
  private view(kind: string, type: string, internal: string) {
    return kind === "metric" && ["sum", "gauge"].includes(type)
      ? "SELECT * EXCEPT(value),value_float AS value FROM " +
          internal +
          " FINAL"
      : "SELECT * FROM " + internal + " FINAL";
  }
  private async refresh(publicName: string, signal?: AbortSignal) {
    const data = await this.ch.query(
      "SELECT name,type FROM system.columns WHERE database='lightmoni' AND table={table:String} ORDER BY position",
      { table: publicName },
      signal,
    );
    const cols: Column[] = data.data.map((row) => ({
      name: String(row.name),
      type: String(row.type),
    }));
    this.db.run(
      "UPDATE catalog SET columns_json=? WHERE name=?",
      JSON.stringify(cols),
      publicName,
    );
    return cols;
  }
  async migrate(signal?: AbortSignal) {
    for (const t of await this.list()) {
      if (
        t.kind !== "metric" ||
        !["sum", "gauge"].includes(t.metric_type ?? "")
      )
        continue;
      if (
        !validTable(t.logical_name) ||
        t.name !== "metric_" + t.logical_name + "_" + t.metric_type
      )
        throw Error("invalid catalog table during migration");
      await this.ch.exec(
        "ALTER TABLE _lm_" +
          t.name +
          " ADD COLUMN IF NOT EXISTS value_int Nullable(Int64) DEFAULT if(value_type='int',toInt64(value),NULL), ADD COLUMN IF NOT EXISTS value_float Float64 DEFAULT toFloat64(value)",
        signal,
      );
      await this.ch.exec(
        "CREATE OR REPLACE VIEW " +
          t.name +
          " DEFINER=" +
          quote(this.ch.user ?? "lightmoni") +
          " SQL SECURITY DEFINER AS " +
          this.view(t.kind, t.metric_type!, "_lm_" + t.name),
        signal,
      );
      await this.refresh(t.name, signal);
    }
  }
  // One serial queue protects catalog creation, retention DDL and compensation.
  async ensure(
    name: string,
    kind: string,
    type = "",
    service = "",
    signal?: AbortSignal,
  ) {
    return this.serial.run(async () => {
      if (!validTable(name)) throw Error("invalid logical table name");
      const publicName = kind + "_" + name + (type ? "_" + type : "");
      const old = this.db.get<any>(
        "SELECT services_json FROM catalog WHERE name=?",
        publicName,
      );
      if (old) {
        const services: string[] = JSON.parse(old.services_json);
        if (service && !services.includes(service)) {
          services.push(service);
          this.db.run(
            "UPDATE catalog SET services_json=? WHERE name=?",
            JSON.stringify(services),
            publicName,
          );
        }
        return publicName;
      }
      if (this.db.get<any>("SELECT count(*) n FROM catalog")!.n >= 200)
        throw Error("maximum table count reached");
      let extra = "";
      if (kind === "log")
        extra =
          "severity LowCardinality(String),severity_number UInt8,body String,body_json String,trace_id String,span_id String,source_id String,source_seq Nullable(UInt64)";
      else if (kind === "trace")
        extra =
          "trace_id String,span_id String,parent_span_id String,name String,kind String,start_time DateTime64(9,'UTC'),end_time DateTime64(9,'UTC'),duration_ns UInt64,status String,events_json String,links_json String";
      else if (kind === "metric") {
        extra =
          "name LowCardinality(String),unit LowCardinality(String),start_time DateTime64(9,'UTC')";
        if (["sum", "gauge"].includes(type))
          extra +=
            ",value Decimal(38,9),value_type String,value_int Nullable(Int64) DEFAULT if(value_type='int',toInt64(value),NULL),value_float Float64 DEFAULT toFloat64(value)" +
            (type === "sum" ? ",temporality String,monotonic Bool" : "");
        else if (type === "histogram")
          extra +=
            ",bounds Array(Float64),bucket_counts Array(UInt64),count UInt64,sum Nullable(Float64),min Nullable(Float64),max Nullable(Float64),temporality String";
        else throw Error("unsupported metric type");
      } else throw Error("unsupported signal");
      const internal = "_lm_" + publicName,
        days = this.defaultRetention();
      await this.ch.exec(
        "CREATE TABLE IF NOT EXISTS " +
          internal +
          " (" +
          common +
          "," +
          extra +
          ") ENGINE=ReplacingMergeTree PARTITION BY toDate(event_time) ORDER BY (service,toDate(event_time),event_time,event_id)" +
          (days > 0 ? " TTL event_time + INTERVAL " + days + " DAY" : "") +
          " SETTINGS fsync_after_insert=1,fsync_part_directory=1",
        signal,
      );
      await this.ch.exec(
        "CREATE OR REPLACE VIEW " +
          publicName +
          " DEFINER=" +
          quote(this.ch.user ?? "lightmoni") +
          " SQL SECURITY DEFINER AS " +
          this.view(kind, type, internal),
        signal,
      );
      await this.ch.exec(
        "GRANT SELECT ON lightmoni." +
          publicName +
          " TO " +
          quote(this.reader.user ?? "lightmoni_reader"),
        signal,
      );
      const data = await this.ch.query(
        "SELECT name,type FROM system.columns WHERE database='lightmoni' AND table={table:String} ORDER BY position",
        { table: publicName },
        signal,
      );
      this.db.run(
        "INSERT INTO catalog(id,name,logical_name,kind,metric_type,columns_json,services_json) VALUES(?,?,?,?,?,?,?)",
        publicName,
        publicName,
        name,
        kind,
        type,
        JSON.stringify(
          data.data.map((c) => ({
            name: String(c.name),
            type: String(c.type),
          })),
        ),
        JSON.stringify(service ? [service] : []),
      );
      return publicName;
    });
  }
  private async apply(t: Table, days: number, signal?: AbortSignal) {
    if (
      !validTable(t.logical_name) ||
      t.name !==
        t.kind +
          "_" +
          t.logical_name +
          (t.kind === "metric" ? "_" + t.metric_type : "") ||
      !["log", "metric", "trace"].includes(t.kind) ||
      (t.kind === "metric" &&
        !["sum", "gauge", "histogram"].includes(t.metric_type!))
    )
      throw Error("invalid retention table");
    await this.ch.exec(
      "ALTER TABLE _lm_" +
        t.name +
        (days
          ? " MODIFY TTL event_time + INTERVAL " + days + " DAY"
          : " REMOVE TTL"),
      signal,
    );
  }
  private async restore(tables: Table[], cause: unknown): Promise<never> {
    const errors = [cause];
    for (const t of tables)
      try {
        await this.apply(
          t,
          t.effective_retention_days,
          AbortSignal.timeout(30000),
        );
      } catch (e) {
        errors.push(e);
      }
    throw new AggregateError(errors, "保留规则更新失败，已尝试恢复");
  }
  async setRetention(
    uid: string | null,
    days: number | null,
    signal?: AbortSignal,
  ) {
    if (days !== null && (!Number.isInteger(days) || days < 0 || days > 36500))
      throw Error("保留时长必须为 0 到 36500 的整数天数，0 表示永久保留");
    return this.serial.run(async () => {
      const tables = await this.list();
      if (uid && !tables.some((t) => t.id === uid))
        throw Error("table not found");
      const targets = tables.filter((t) =>
          uid ? t.id === uid : t.retention_days === null,
        ),
        effective = days ?? this.defaultRetention(),
        attempted: Table[] = [];
      try {
        for (const t of targets) {
          if (t.effective_retention_days === effective) continue;
          attempted.push(t);
          await this.apply(t, effective, signal);
        }
        if (uid)
          this.db.run(
            "UPDATE catalog SET retention_days=? WHERE id=?",
            days,
            uid,
          );
        else
          this.db.run(
            "UPDATE retention_config SET default_days=? WHERE id=1",
            effective,
          );
      } catch (e) {
        return this.restore(attempted, e);
      }
    });
  }
}
