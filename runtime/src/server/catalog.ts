import type { Table, Column, ClickHouse as CH } from "../shared/types.js";
import { DB } from "../shared/sqlite.js";
import { Serial } from "../shared/serial.js";
import { validTable, systemTable } from "./auth.js";
const common =
  "event_id String,event_time DateTime64(9,'UTC'),ingested_at DateTime64(9,'UTC'),service LowCardinality(String),instance_id String,host_id String,agent_id String,key_id String,resource_json String,attributes Map(String,String),attributes_json String,env LowCardinality(String) DEFAULT JSONExtractString(resource_json,'deployment.environment.name'),service_version LowCardinality(String) DEFAULT JSONExtractString(resource_json,'service.version'),component LowCardinality(String) DEFAULT attributes['lightmoni.component']";
const dimensionColumns = Array.from(
  { length: 16 },
  (_, i) => `key${i + 1} String DEFAULT attributes['key${i + 1}']`,
).join(",");
export const publicTableName = (name: string, kind: string, type = "") =>
  name === "lightmoni"
    ? "lightmoni_" + kind + (type ? "_" + type : "")
    : kind + "_" + name + (type ? "_" + type : "");
const oldSystem = ["lightmoni_center", "lightmoni_agent", "lightmoni_sdk"];
const alignedColumns = "window_start DateTime64(9,'UTC') DEFAULT start_time,window_seconds UInt32 DEFAULT 0,received_at DateTime64(9,'UTC') DEFAULT ingested_at,positive_offset Int32 DEFAULT 0,positive_counts Array(UInt64) DEFAULT [],negative_offset Int32 DEFAULT 0,negative_counts Array(UInt64) DEFAULT [],zero_count UInt64 DEFAULT 0";
const histogramColumns =
  alignedColumns+",bucket_values Array(Float64) DEFAULT [],distribution_count UInt64 DEFAULT count,distribution_kind LowCardinality(String) DEFAULT 'explicit',sketch_scale Nullable(Int32),quantile_error Nullable(Float64)";
const quote = (s: string) => "`" + s.replace(/`/g, "``") + "`";
function compactBuckets(internal:string){
 const c=(name:string)=>internal+'.'+name;
 const width=`pow(2.,-toFloat64(assumeNotNull(${c('sketch_scale')})))`;
 const side=(name:string,sign:number)=>`arrayMap((n,i)->tuple(${sign}*exp2((${c(name+'_offset')}+i-1)*${width}+1-log2(1+exp2(-${width}))),n),${c(name+'_counts')},arrayEnumerate(${c(name+'_counts')}))`;
 const pairs=`arrayFilter(p->p.2>0,arrayConcat(${side('negative',-1)},[tuple(0.,${c('zero_count')})],${side('positive',1)}))`;
 const compact=`notEmpty(${c('positive_counts')}) OR notEmpty(${c('negative_counts')}) OR ${c('zero_count')}>0`;
 return {values:`if(${compact},arrayMap(p->if(isNull(${c('min')}) OR isNull(${c('max')}),p.1,greatest(assumeNotNull(${c('min')}),least(assumeNotNull(${c('max')}),p.1))),${pairs}),${c('bucket_values')})`,counts:`if(${compact},arrayMap(p->p.2,${pairs}),${c('bucket_counts')})`};
}
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
    if (
      !db
        .all<any>("PRAGMA table_info(catalog)")
        .some((c) => c.name === "is_compat_alias")
    )
      db.exec(
        "ALTER TABLE catalog ADD COLUMN is_compat_alias INTEGER NOT NULL DEFAULT 0",
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
  private projection(
    kind: string,
    type: string,
    internal: string,
    component = "",
    filter = "",
  ) {
    const compact=compactBuckets(internal);
    const fields = [
      "event_id",
      "event_time",
      "ingested_at",
      "service",
      "instance_id",
      "host_id",
      "agent_id",
      "key_id",
      "resource_json",
      "attributes",
      "attributes_json",
    ];
    if (kind === "log")
      fields.push(
        "severity",
        "severity_number",
        "body",
        "body_json",
        "trace_id",
        "span_id",
        "source_id",
        "source_seq",
      );
    else if (kind === "trace")
      fields.push(
        "trace_id",
        "span_id",
        "parent_span_id",
        "name",
        "kind",
        "start_time",
        "end_time",
        "duration_ns",
        "status",
        "events_json",
        "links_json",
      );
    else {
      fields.push("name", "unit", "start_time");
      if (type === "histogram")
        fields.push(
          "bounds",
          compact.counts+" AS bucket_counts",
          "count",
          "sum",
          "min",
          "max",
          "temporality",
          compact.values+" AS bucket_values",
          "distribution_count",
          "distribution_kind",
          "sketch_scale",
          "quantile_error",
          "count AS sample_count",
          "sum AS value_sum",
          "sum AS value",
          "window_start", "window_seconds", "received_at",
          "positive_offset", "positive_counts", "negative_offset", "negative_counts", "zero_count",
          "CAST(tuple(bucket_values,if(length(bucket_values)=length(bucket_counts),bucket_counts,[]),count,distribution_count,min,max,quantile_error),'Tuple(values Array(Float64),counts Array(UInt64),total UInt64,known UInt64,low Nullable(Float64),high Nullable(Float64),error Nullable(Float64))') AS distribution",
          "min AS value_min",
          "max AS value_max",
        );
      else {
        fields.push(
          "value_type",
          "value_int",
          "value_float",
          "value_float AS value",
        );
        if (type === "sum") fields.push("temporality", "monotonic");
      }
      fields.push(
        "name AS metric_name",
        ...Array.from({ length: 16 }, (_, i) => `key${i + 1}`),
      );
    }
    fields.push(
      "env",
      "service_version",
      component ? `'${component}' AS component` : "component",
    );
    return (
      "SELECT " +
      fields.join(",") +
      " FROM " +
      internal +
      " FINAL" +
      (filter ? " WHERE " + filter : "")
    );
  }
  private view(kind: string, type: string, internal: string, logical = "") {
    const canonical = publicTableName("lightmoni", kind, type),
      sources: string[] = [];
    if (logical === "lightmoni") {
      sources.push(this.projection(kind, type, internal));
      for (const row of this.db.all<any>(
        "SELECT * FROM catalog WHERE kind=? AND metric_type=? AND is_compat_alias=0",
        kind,
        type,
      ))
        if (oldSystem.includes(row.logical_name))
          sources.push(
            this.projection(
              kind,
              type,
              "_lm_" + row.name,
              row.logical_name.slice(10),
            ),
          );
    } else if (oldSystem.includes(logical)) {
      const old = this.db.get<any>(
        "SELECT is_compat_alias FROM catalog WHERE name=?",
        internal.slice(4),
      );
      if (old && !old.is_compat_alias)
        sources.push(this.projection(kind, type, internal, logical.slice(10)));
      if (this.db.get("SELECT 1 FROM catalog WHERE name=?", canonical))
        sources.push(
          this.projection(
            kind,
            type,
            "_lm_" + canonical,
            "",
            `attributes['lightmoni.component']='${logical.slice(10)}'`,
          ),
        );
    } else sources.push(this.projection(kind, type, internal));
    return sources.join(" UNION ALL ");
  }
  private async replaceView(
    name: string,
    kind: string,
    type: string,
    logical: string,
    signal?: AbortSignal,
  ) {
    await this.ch.exec(
      "CREATE OR REPLACE VIEW " +
        name +
        " DEFINER=" +
        quote(this.ch.user ?? "lightmoni") +
        " SQL SECURITY DEFINER AS " +
        this.view(kind, type, "_lm_" + name, logical),
      signal,
    );
    await this.ch.exec(
      "GRANT SELECT ON lightmoni." +
        name +
        " TO " +
        quote(this.reader.user ?? "lightmoni_reader"),
      signal,
    );
    await this.refresh(name, signal);
    if(kind==='metric'&&type==='histogram'&&!systemTable(logical)){
      await this.ch.exec('CREATE OR REPLACE VIEW '+logical+' DEFINER='+quote(this.ch.user??'lightmoni')+' SQL SECURITY DEFINER AS SELECT * FROM '+name,signal);
      await this.ch.exec('GRANT SELECT ON lightmoni.'+logical+' TO '+quote(this.reader.user??'lightmoni_reader'),signal);
    }
  }
  private async compatibility(
    kind: string,
    type: string,
    signal?: AbortSignal,
  ) {
    for (const logical of kind === "log" || type === "gauge"
      ? oldSystem
      : [oldSystem[0]]) {
      const name = publicTableName(logical, kind, type);
      this.db.run(
        "INSERT OR IGNORE INTO catalog(id,name,logical_name,kind,metric_type,columns_json,services_json,is_compat_alias) VALUES(?,?,?,?,?,'[]','[]',1)",
        name,
        name,
        logical,
        kind,
        type,
      );
      await this.replaceView(name, kind, type, logical, signal);
    }
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
    const tables = await this.list();
    for (const t of tables) {
      if (
        !validTable(t.logical_name) ||
        t.name !== publicTableName(t.logical_name, t.kind, t.metric_type ?? "")
      )
        throw Error("invalid catalog table during migration");
      if ((t as any).is_compat_alias) continue;
      await this.ch.exec(
        "ALTER TABLE _lm_" +
          t.name +
          " ADD COLUMN IF NOT EXISTS env LowCardinality(String) DEFAULT JSONExtractString(resource_json,'deployment.environment.name'), ADD COLUMN IF NOT EXISTS service_version LowCardinality(String) DEFAULT JSONExtractString(resource_json,'service.version'), ADD COLUMN IF NOT EXISTS component LowCardinality(String) DEFAULT attributes['lightmoni.component']",
        signal,
      );
      if (t.kind === "metric")
        await this.ch.exec(
          "ALTER TABLE _lm_" +
            t.name +
            " " +
            Array.from(
              { length: 16 },
              (_, i) =>
                `ADD COLUMN IF NOT EXISTS key${i + 1} String DEFAULT attributes['key${i + 1}']`,
            ).join(","),
          signal,
        );
      if (t.kind === "metric" && ["sum", "gauge"].includes(t.metric_type ?? ""))
        await this.ch.exec(
          "ALTER TABLE _lm_" +
            t.name +
            " ADD COLUMN IF NOT EXISTS value_int Nullable(Int64) DEFAULT if(value_type='int',toInt64(value),NULL), ADD COLUMN IF NOT EXISTS value_float Float64 DEFAULT toFloat64(value)",
          signal,
        );
      if (t.kind === "metric" && t.metric_type === "histogram")
        await this.ch.exec('ALTER TABLE _lm_'+t.name+' '+alignedColumns.split(/,(?=[a-z_]+ (?:DateTime|UInt|Int|Array))/).map(c=>'ADD COLUMN IF NOT EXISTS '+c).join(','),signal);
      if (t.kind === "metric" && t.metric_type === "histogram")
        await this.ch.exec(
          "ALTER TABLE _lm_" +
            t.name +
            " ADD COLUMN IF NOT EXISTS bucket_values Array(Float64) DEFAULT [], ADD COLUMN IF NOT EXISTS distribution_count UInt64 DEFAULT if(empty(bucket_values),0,count), ADD COLUMN IF NOT EXISTS distribution_kind LowCardinality(String) DEFAULT 'explicit', ADD COLUMN IF NOT EXISTS sketch_scale Nullable(Int32), ADD COLUMN IF NOT EXISTS quantile_error Nullable(Float64)",
          signal,
        );
    }
    for (const t of tables)
      await this.replaceView(
        t.name,
        t.kind,
        t.metric_type ?? "",
        t.logical_name,
        signal,
      );
    for (const t of tables)
      if (t.logical_name === "lightmoni") {
        await this.compatibility(t.kind, t.metric_type ?? "", signal);
        await this.replaceView(
          t.name,
          t.kind,
          t.metric_type ?? "",
          t.logical_name,
          signal,
        );
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
      if (systemTable(name) && name !== "lightmoni_application") name = "lightmoni";
      const publicName = publicTableName(name, kind, type);
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
      if (
        this.db.get<any>(
          "SELECT count(*) n FROM catalog WHERE is_compat_alias=0",
        )!.n >= 200
      )
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
          "name LowCardinality(String),unit LowCardinality(String),start_time DateTime64(9,'UTC')," +
          dimensionColumns;
        if (["sum", "gauge"].includes(type))
          extra +=
            ",value Decimal(38,9),value_type String,value_int Nullable(Int64) DEFAULT if(value_type='int',toInt64(value),NULL),value_float Float64 DEFAULT toFloat64(value)" +
            (type === "sum" ? ",temporality String,monotonic Bool" : "");
        else if (type === "histogram")
          extra +=
            ",bounds Array(Float64),bucket_counts Array(UInt64),count UInt64,sum Nullable(Float64),min Nullable(Float64),max Nullable(Float64),temporality String," +
            histogramColumns;
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
          this.view(kind, type, internal, name),
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
      if(kind==='metric'&&type==='histogram'&&!systemTable(name))await this.replaceView(publicName,kind,type,name,signal);
      if (name === "lightmoni") {
        await this.compatibility(kind, type, signal);
        await this.replaceView(publicName, kind, type, name, signal);
      }
      return publicName;
    });
  }
  private async apply(t: Table, days: number, signal?: AbortSignal) {
    if ((t as any).is_compat_alias) return;
    if (
      !validTable(t.logical_name) ||
      t.name !== publicTableName(t.logical_name, t.kind, t.metric_type ?? "") ||
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
