import { createHash, randomBytes } from "node:crypto";
import { normalize as clean } from "node:path";
import type { DB } from "../shared/types.js";
import { validateTaskScript, SCRIPT_TASK_CAPABILITIES, supportsTaskScript, type TaskScript } from "../shared/task-center.js";
import { nextTaskDates, normalizeTaskSchedule, normalizeTaskPolicy, type TaskSchedule, type TaskExecutionPolicy } from "./task-schedule.js";
export type { TaskSchedule, TaskExecutionPolicy } from "./task-schedule.js";
export type { TaskScript } from "../shared/task-center.js";
import { agentLifecycle, assertAgentActive, createAgentLifecycleSchema } from "./agent-lifecycle.js";
import { createAgentHostSchema, ensureAgentHost } from "./agent-hosts.js";
import {
  normalizeRemote,
  validateRemote,
  type RemoteConfig,
  type Probe,
  type LogSource,
} from "../agent/config.js";
export class NodeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const problem = (status: number, message: string): never => {
  throw new NodeError(status, message);
};
export const nodeID = () => randomBytes(16).toString("hex");
const length = (value: string) => Buffer.byteLength(value);
export const unique = (values: string[]) => [...new Set(values)].sort();
export const validName = (name: any) =>
  typeof name === "string" && !!name.trim() && length(name.trim()) <= 128;
export interface Task {
  id: string;
  revision?: string;
  name: string;
  type: string;
  enabled: boolean;
  label_ids: string[];
  config: RemoteConfig;
  origin: "builtin" | "custom";
  target_all: boolean;
  host_ids: string[];
  schedule: TaskSchedule;
  script?: TaskScript;
  execution_policy?: TaskExecutionPolicy;
}
export interface EffectiveHostTask extends Task { status: "disabled" | "waiting_config" | "waiting_agent" | "active" | "ready" | "overridden_by_custom" | "upgrade_required"; overridden: boolean }
export interface Label {
  id: string;
  name: string;
  node_count: number;
  host_count: number;
  task_count: number;
}
export interface Compiled {
  config: RemoteConfig;
  labels: { id: string; name: string }[];
  tasks: { id: string; name: string; type: string }[];
  label_ids: string[];
  task_ids: string[];
}
/** Stable digest of the complete executable definition, excluding view-only fields. */
export function taskRevision(task: Task): string {
  const { revision: _revision, status: _status, overridden: _overridden, ...definition } = task as Task & {status?:string;overridden?:boolean};
  const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
  return createHash("sha256").update(JSON.stringify(canonical(definition))).digest("hex");
}
const goJSON = (value: any) =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
export function wire(c: RemoteConfig): RemoteConfig {
  return {
    revision: c.revision,
    collect_interval_seconds: c.collect_interval_seconds,
    probes: (c.probes ?? []).map((p) => ({
      id: p.id,
      kind: p.kind,
      target: p.target,
      interval_seconds: p.interval_seconds,
      timeout_ms: p.timeout_ms,
      ...(p.expected_status?.length
        ? { expected_status: p.expected_status }
        : {}),
    })),
    host_enabled: c.host_enabled,
    host_collectors: c.host_collectors ?? [],
    host_table: c.host_table,
    probe_table: c.probe_table,
    process_names: c.process_names ?? [],
    ...(c.group_id ? { group_id: c.group_id } : {}),
    logs_enabled: c.logs_enabled,
    log_table: c.log_table,
    log_sources: (c.log_sources ?? []).map((s) => ({
      directory: s.directory,
      pattern: s.pattern,
      recursive: s.recursive,
      from_beginning: s.from_beginning,
    })),
  } as RemoteConfig;
}
function remote(value: any = {}): RemoteConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    problem(400, "任务配置无效");
  const c: RemoteConfig = (() => {
    try {
      return normalizeRemote({
        ...value,
        collect_interval_seconds: value.collect_interval_seconds ?? 0,
      });
    } catch {
      return problem(400, "任务配置无效");
    }
  })();
  for (const field of ["host_enabled", "logs_enabled"] as const)
    if (typeof c[field] !== "boolean") problem(400, "任务配置无效");
  return wire(c);
}
const record = (value: any) => !!value && typeof value === "object" && !Array.isArray(value);
const identifiers = (values: any, field: string, max = 64): string[] => {
  if (!Array.isArray(values) || values.length > max || values.some((value: any) => typeof value !== "string" || !value.trim() || length(value) > 128))
    problem(400, `${field}无效，最多 ${max} 项`);
  return unique(values);
};
export function normalizeTask(input: any): Task {
  if (record(input) && Object.hasOwn(input, "template_id")) problem(400, "任务模板字段已移除");
  if (!record(input) || !validName(input.name)) problem(400, "请填写任务名称，最长 128 字节");
  if (input.enabled != null && typeof input.enabled !== "boolean" || input.target_all != null && typeof input.target_all !== "boolean") problem(400, "任务开关无效");
  const type = input.type;
  if (!["host", "probe", "log", "script"].includes(type)) problem(400, "任务类型必须是 host、probe、log 或 script");
  let schedule: TaskSchedule;
  try { schedule = normalizeTaskSchedule(input.schedule ?? { mode: type === "script" ? "once" : "continuous" }, type); }
  catch (error) { return problem(400, (error as Error).message); }
  const t: Task = {
    id: input.id || "", name: input.name.trim(), type, enabled: input.enabled ?? false,
    label_ids: identifiers(input.label_ids ?? [], "主机标签"),
    host_ids: identifiers(input.host_ids ?? [], "目标主机", 500), target_all: input.target_all ?? false,
    origin: input.origin === "builtin" ? "builtin" : "custom",
    schedule,
    config: remote({ revision: "validate", collect_interval_seconds: 15, host_enabled: false, host_collectors: [], logs_enabled: false }),
  };
  if (input.origin != null && !["builtin", "custom"].includes(input.origin)) problem(400, "任务来源无效");
  if (type === "script") {
    const script = input.script;
    if (!record(script) || !["shell", "node"].includes(script.runtime) || typeof script.code !== "string" || !script.code.trim() || length(script.code) > 64 * 1024 || script.code.includes("\0")) problem(400, "脚本须为非空 shell 或 Node.js 代码，最长 64 KiB");
    if (Object.keys(script).some(key => !["runtime", "code", "timeout_seconds", "max_output_bytes", "args", "cwd"].includes(key))) problem(400, "脚本包含不支持的字段");
    const timeout = script.timeout_seconds ?? 60, output = script.max_output_bytes ?? 65536;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3600 || !Number.isSafeInteger(output) || output < 1024 || output > 262144) problem(400, "脚本超时或输出上限无效");
    t.script = { runtime: script.runtime, code: script.code, timeout_seconds: timeout, max_output_bytes: output,
      ...(script.args?.length ? {args:script.args} : {}), ...(script.cwd ? {cwd:script.cwd} : {}) };
    try { validateTaskScript(t.script); } catch { problem(400, "脚本配置无效"); }
    // Validate supplied empty/invalid optional values before dropping empty defaults.
    try { validateTaskScript({...t.script, ...(script.args != null ? {args:script.args} : {}), ...(script.cwd != null ? {cwd:script.cwd} : {})}); }
    catch { problem(400, "脚本参数或工作目录无效"); }
    try { t.execution_policy = normalizeTaskPolicy(input.execution_policy); }
    catch (error) { problem(400, (error as Error).message); }
  } else {
    if (input.script != null) problem(400, "内置处理器任务不接受脚本字段");
    if (input.execution_policy != null) problem(400, "持续采集任务不接受脚本执行策略");
    const source = remote(input.config ?? {}), c = t.config;
    if (type === "host") Object.assign(c, { collect_interval_seconds: source.collect_interval_seconds, host_table: source.host_table, host_collectors: source.host_collectors, process_names: source.process_names, host_enabled: true });
    else if (type === "probe") Object.assign(c, { probe_table: source.probe_table, probes: source.probes });
    else Object.assign(c, { log_table: source.log_table, log_sources: source.log_sources, logs_enabled: source.log_sources.length > 0 });
    if (type === "host" && !c.host_collectors.length && !t.enabled) c.host_enabled = false;
    try { validateRemote(c); } catch (error) { problem(400, "任务配置无效：" + (error instanceof Error ? error.message : "invalid config")); }
  }
  t.config.revision = ""; delete (t.config as any).group_id;
  t.config = wire(t.config);
  t.revision = taskRevision(t);
  return t;
}

export class NodeStore {
  constructor(
    readonly db: DB,
    readonly now: () => Date,
  ) {
    this.init();
  }
  timestamp() {
    return this.now().toISOString();
  }
  init(): void {
    const fresh = !this.db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('agent_groups','agent_tasks') LIMIT 1");
    createAgentLifecycleSchema(this.db);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY,host_id TEXT NOT NULL,hostname TEXT NOT NULL,version TEXT NOT NULL,platform TEXT NOT NULL,arch TEXT NOT NULL,last_seen TEXT NOT NULL,heartbeat TEXT NOT NULL,group_id TEXT NOT NULL DEFAULT 'default'); CREATE TABLE IF NOT EXISTS agent_runtime_events(agent_id TEXT NOT NULL,event_id TEXT NOT NULL,key_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(agent_id,event_id)); CREATE TABLE IF NOT EXISTS agent_groups(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,config TEXT NOT NULL,created_at TEXT NOT NULL);`,
    );
    createAgentHostSchema(this.db);
    if (
      !this.db
        .all<any>("PRAGMA table_info('agents')")
        .some((row) => row.name === "group_id")
    )
      this.db.exec(
        "ALTER TABLE agents ADD COLUMN group_id TEXT NOT NULL DEFAULT 'default'",
      );
    const initial = remote({
      revision: nodeID(),
      collect_interval_seconds: 15,
    });
    this.db.run(
      "INSERT OR IGNORE INTO agent_groups(id,name,config,created_at) VALUES('default','默认分组',?,?)",
      goJSON(initial),
      this.timestamp(),
    );
    this.db.transaction(() => {
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS agent_task_migrations(version TEXT PRIMARY KEY,completed_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS agent_task_labels(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS agent_tasks(id TEXT PRIMARY KEY,name TEXT NOT NULL,type TEXT NOT NULL,enabled INTEGER NOT NULL,config TEXT NOT NULL,created_at TEXT NOT NULL,metadata_json TEXT NOT NULL DEFAULT '{}'); CREATE TABLE IF NOT EXISTS agent_task_targets(task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,label_id TEXT NOT NULL REFERENCES agent_task_labels(id),PRIMARY KEY(task_id,label_id)); CREATE TABLE IF NOT EXISTS agent_node_labels(agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,label_id TEXT NOT NULL REFERENCES agent_task_labels(id),PRIMARY KEY(agent_id,label_id)); CREATE INDEX IF NOT EXISTS agent_task_targets_label ON agent_task_targets(label_id); CREATE INDEX IF NOT EXISTS agent_node_labels_label ON agent_node_labels(label_id);`,
      );
      if (!this.db.all<{name:string}>("PRAGMA table_info(agent_tasks)").some(column => column.name === "metadata_json")) this.db.exec("ALTER TABLE agent_tasks ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
      this.db.exec(`CREATE TABLE IF NOT EXISTS machine_host_labels(machine_id TEXT NOT NULL REFERENCES managed_machines(id) ON DELETE CASCADE,label_id TEXT NOT NULL REFERENCES agent_task_labels(id),PRIMARY KEY(machine_id,label_id)); CREATE INDEX IF NOT EXISTS machine_host_labels_label ON machine_host_labels(label_id); CREATE TABLE IF NOT EXISTS machine_task_overrides(machine_id TEXT NOT NULL REFERENCES managed_machines(id) ON DELETE CASCADE,task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,override_json TEXT NOT NULL,PRIMARY KEY(machine_id,task_id));`);
      if (
        this.db.get(
          "SELECT 1 FROM agent_task_migrations WHERE version='independent-tasks-v1'",
        )
      )
        return;
      for (const group of this.db.all<any>(
        "SELECT * FROM agent_groups ORDER BY id",
      )) {
        let name =
          group.id === "default" && group.name === "默认分组"
            ? "默认标签"
            : group.name;
        if (
          this.db.get(
            "SELECT 1 FROM agent_groups WHERE id<>? AND name=?",
            group.id,
            name,
          )
        )
          name = group.name;
        this.db.run(
          "INSERT INTO agent_task_labels(id,name,created_at) VALUES(?,?,?)",
          group.id,
          name,
          group.created_at,
        );
        // A fresh installation starts from persisted platform tasks below.
        // Existing group definitions remain user tasks during upgrade.
        if (!fresh) this.legacyTasks(group.id, name, remote(JSON.parse(group.config)));
      }
      this.db.run(
        "INSERT INTO agent_node_labels(agent_id,label_id) SELECT id,group_id FROM agents",
      );
      this.db.run(
        "INSERT INTO agent_task_migrations(version,completed_at) VALUES('independent-tasks-v1',?)",
        this.timestamp(),
      );
    });
    this.db.transaction(() => {
      if (this.db.get("SELECT 1 FROM agent_task_migrations WHERE version='host-task-center-v1'")) return;
      this.db.run("INSERT OR IGNORE INTO machine_host_labels(machine_id,label_id) SELECT m.id,n.label_id FROM managed_machines m JOIN agent_node_labels n ON n.agent_id=m.agent_id");
      this.db.run("INSERT INTO agent_task_migrations(version,completed_at) VALUES('host-task-center-v1',?)", this.timestamp());
    });
    this.db.transaction(() => {
      if (this.db.get("SELECT 1 FROM agent_task_migrations WHERE version='platform-default-tasks-v1'")) return;
      // Definition metadata is retired, never historical execution snapshots.
      this.db.run("UPDATE agent_tasks SET metadata_json=json_remove(metadata_json,'$.template_id')");
      const existing = this.tasks();
      for (const definition of [
        { type: "host", name: "指标采集", config: { collect_interval_seconds: 15 } },
        { type: "probe", name: "服务拨测", config: {} },
        { type: "log", name: "目录日志", config: {} },
      ]) {
        if (existing.some(task => task.origin === "builtin" && task.type === definition.type)) continue;
        // IDs from a prior release may already belong to user definitions or
        // a builtin whose type was changed. Never overwrite either identity.
        const base = `platform-default:${definition.type}`;
        let id = base, suffix = 1;
        while (this.db.get("SELECT 1 FROM agent_tasks WHERE id=?", id)) id = `${base}:${suffix++}`;
        this.saveTask(normalizeTask({ ...definition, id, origin: "builtin", enabled: true, target_all: true }));
      }
      this.db.run("INSERT INTO agent_task_migrations(version,completed_at) VALUES('platform-default-tasks-v1',?)", this.timestamp());
    });
  }
  labels(): Label[] {
    return this.db.all<Label>(
      `SELECT l.id,l.name,(SELECT count(*) FROM machine_host_labels WHERE label_id=l.id) AS host_count,(SELECT count(*) FROM machine_host_labels h JOIN managed_machines m ON m.id=h.machine_id WHERE h.label_id=l.id AND m.agent_id<>'' AND NOT EXISTS(SELECT 1 FROM agent_lifecycle x WHERE x.agent_id=m.agent_id AND x.state='removed')) AS node_count,(SELECT count(*) FROM agent_task_targets WHERE label_id=l.id) AS task_count FROM agent_task_labels l ORDER BY CASE WHEN l.id='default' THEN 0 ELSE 1 END,l.created_at,l.id`,
    );
  }
  tasks(): Task[] {
    return this.db.all<any>("SELECT id,name,type,enabled,config,metadata_json FROM agent_tasks ORDER BY created_at,id").map(row => {
      const {template_id: _removedTemplate, ...meta} = JSON.parse(row.metadata_json || "{}");
      const task = { ...meta, id: row.id, name: row.name, type: row.type, enabled: !!row.enabled,
        origin: meta.origin ?? "custom", target_all: meta.target_all ?? false,
        host_ids: meta.host_ids ?? [], schedule: meta.schedule ?? { mode: row.type === "script" ? "once" : "continuous" },
        ...(row.type === "script" ? {execution_policy:normalizeTaskPolicy(meta.execution_policy)} : {}),
        config: wire(normalizeRemote(JSON.parse(row.config))),
        label_ids: this.db.all<{label_id:string}>("SELECT label_id FROM agent_task_targets WHERE task_id=? ORDER BY label_id", row.id).map(value => value.label_id),
      } as Task;
      task.revision = taskRevision(task);
      return task;
    });
  }
  getTask(id: string): Task {
    return this.tasks().find(task => task.id === id) ?? problem(404, "任务不存在");
  }
  saveTask(t: Task): void {
    for (const hostID of t.host_ids) this.assertHost(hostID);
    const { origin, target_all, host_ids, schedule, script, execution_policy } = t;
    this.db.run("INSERT INTO agent_tasks(id,name,type,enabled,config,metadata_json,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,type=excluded.type,enabled=excluded.enabled,config=excluded.config,metadata_json=excluded.metadata_json",
      t.id, t.name, t.type, t.enabled, goJSON(t.config), goJSON({ origin, target_all, host_ids, schedule, ...(script ? { script, execution_policy } : {}) }), this.timestamp());
    this.db.run("DELETE FROM agent_task_targets WHERE task_id=?", t.id);
    for (const label of t.label_ids) {
      if (!this.db.get("SELECT 1 FROM agent_task_labels WHERE id=?", label)) problem(404, "主机标签不存在：" + label);
      this.db.run("INSERT INTO agent_task_targets(task_id,label_id) VALUES(?,?)", t.id, label);
    }
  }
  legacyTasks(label: string, name: string, c: RemoteConfig): void {
    for (const kind of ["host", "probe", "log"]) {
      const suffix = (
        { host: " · 指标采集", probe: " · 服务拨测", log: " · 目录日志" } as any
      )[kind];
      let prefix = Array.from(name);
      while (length(prefix.join("") + suffix) > 128) prefix.pop();
      const enabled =
        kind === "host"
          ? c.host_enabled
          : kind === "probe"
            ? c.probes.length > 0
            : c.logs_enabled;
      this.saveTask(
        normalizeTask({
          id: `legacy:${label}:${kind}`,
          name: prefix.join("") + suffix,
          type: kind,
          enabled,
          label_ids: [label],
          config: c,
        }),
      );
    }
  }
  assertHost(id: string): any {
    return this.db.get<any>("SELECT * FROM managed_machines WHERE id=?", id) ?? problem(404, "主机不存在");
  }
  hostLabels(id: string): string[] {
    this.assertHost(id);
    return this.db.all<{label_id:string}>("SELECT label_id FROM machine_host_labels WHERE machine_id=? ORDER BY label_id", id).map(row => row.label_id);
  }
  hostDirectory(): any[] {
    const labels = this.labels();
    return this.db.all<any>("SELECT id,name,agent_id,agent_last_seen FROM managed_machines ORDER BY name,id").map(host => {
      const ids = this.hostLabels(host.id), node = host.agent_id ? this.db.get<any>("SELECT last_seen,heartbeat FROM agents WHERE id=?", host.agent_id) : undefined;
      const removed = host.agent_id && this.db.get("SELECT 1 FROM agent_lifecycle WHERE agent_id=? AND state='removed'", host.agent_id);
      return { id: host.id, name: host.name, agent_id: host.agent_id, agent_status: removed ? "removed" : !host.agent_id ? "missing" : node && this.now().getTime() - Date.parse(node.last_seen) <= 90_000 ? "online" : "offline", task_capabilities: node && Array.isArray(JSON.parse(node.heartbeat || "{}").task_capabilities) ? JSON.parse(node.heartbeat || "{}").task_capabilities.filter((capability:string) => (SCRIPT_TASK_CAPABILITIES as readonly string[]).includes(capability)) : [], label_ids: ids, labels: labels.filter(label => ids.includes(label.id)).map(({id,name}) => ({id,name})) };
    });
  }
  setHostLabels(id: string, values: any, inTransaction = false): string[] {
    const work = () => {
      this.assertHost(id);
      const ids = identifiers(values, "主机标签");
      for (const label of ids) if (!this.db.get("SELECT 1 FROM agent_task_labels WHERE id=?", label)) problem(404, "主机标签不存在");
      this.db.run("DELETE FROM machine_host_labels WHERE machine_id=?", id);
      for (const label of ids) this.db.run("INSERT INTO machine_host_labels(machine_id,label_id) VALUES(?,?)", id, label);
      this.compile(ids, ids[0] || "default", id);
      this.db.run("UPDATE managed_machines SET updated_at=? WHERE id=?", this.timestamp(), id);
      return ids;
    };
    return inTransaction ? work() : this.db.transaction(work);
  }
  effectiveHostTasks(hostID: string): EffectiveHostTask[] {
    const host = this.assertHost(hostID), ids = this.hostLabels(hostID);
    const node = host.agent_id && this.db.get<any>("SELECT last_seen,heartbeat FROM agents WHERE id=?", host.agent_id);
    const connected = !!node && !this.db.get("SELECT 1 FROM agent_lifecycle WHERE agent_id=? AND state='removed'", host.agent_id) && this.now().getTime() - Date.parse(node.last_seen) <= 90_000;
    const capabilities = node ? JSON.parse(node.heartbeat || "{}").task_capabilities : [];
    const matched = this.tasks().filter(task => task.target_all || task.host_ids.includes(hostID) || task.label_ids.some(id => ids.includes(id))).map(task => {
      const saved = this.db.get<{override_json:string}>("SELECT override_json FROM machine_task_overrides WHERE machine_id=? AND task_id=?", hostID, task.id);
      const override = saved ? JSON.parse(saved.override_json) : {};
      const effective = normalizeTask({ ...task, ...override, config: override.config ? { ...task.config, ...override.config } : task.config });
      const needsConfig = effective.type === "probe" && !effective.config.probes.length || effective.type === "log" && !effective.config.log_sources.length;
      return { ...effective, overridden: !!saved, status: !effective.enabled ? "disabled" : needsConfig ? "waiting_config" : !connected ? "waiting_agent" : effective.type === "script" ? supportsTaskScript(capabilities,effective.script) ? "ready" : "upgrade_required" : "active" } as EffectiveHostTask;
    });
    if (matched.some(task => task.enabled && task.origin === "custom" && task.type === "host"))
      for (const task of matched) if (task.enabled && task.origin === "builtin" && task.type === "host") task.status = "overridden_by_custom";
    return matched;
  }
  setOverride(hostID: string, taskID: string, input: any): EffectiveHostTask[] {
    return this.db.transaction(() => {
      this.assertHost(hostID);
      const task = this.getTask(taskID);
      if (!record(input) || !Object.keys(input).length || Object.keys(input).some(key => !["enabled", "config"].includes(key)) || input.enabled != null && typeof input.enabled !== "boolean" || input.config != null && (!record(input.config) || task.type === "script")) problem(400, "主机任务覆盖无效");
      if (!this.effectiveHostTasks(hostID).some(value => value.id === taskID)) problem(409, "任务未派发到此主机");
      const old = this.db.get<{override_json:string}>("SELECT override_json FROM machine_task_overrides WHERE machine_id=? AND task_id=?", hostID, taskID);
      const override = { ...(old ? JSON.parse(old.override_json) : {}), ...input };
      const normalized = normalizeTask({ ...task, ...override, config: override.config ? { ...task.config, ...override.config } : task.config });
      if (override.config) override.config = normalized.config;
      this.db.run("INSERT INTO machine_task_overrides(machine_id,task_id,override_json) VALUES(?,?,?) ON CONFLICT(machine_id,task_id) DO UPDATE SET override_json=excluded.override_json", hostID, taskID, goJSON(override));
      this.compile(this.hostLabels(hostID), "", hostID);
      return this.effectiveHostTasks(hostID);
    });
  }
  clearOverride(hostID: string, taskID: string): EffectiveHostTask[] {
    return this.db.transaction(() => {
      this.assertHost(hostID); this.getTask(taskID);
      this.db.run("DELETE FROM machine_task_overrides WHERE machine_id=? AND task_id=?", hostID, taskID);
      this.compile(this.hostLabels(hostID), "", hostID);
      return this.effectiveHostTasks(hostID);
    });
  }
  nodeLabels(id: string): string[] {
    const host = this.db.get<{id:string}>("SELECT id FROM managed_machines WHERE agent_id=? ORDER BY created_at,id LIMIT 1", id);
    return host ? this.hostLabels(host.id) : this.db.all<{label_id:string}>("SELECT label_id FROM agent_node_labels WHERE agent_id=? ORDER BY label_id", id).map(row => row.label_id);
  }
  compile(ids: string[], group = "", hostID = ""): Compiled {
    const labels = this.labels()
      .filter((label) => ids.includes(label.id))
      .map(({ id, name }) => ({ id, name }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (unique(ids).length !== labels.length) problem(404, "任务标签不存在");
    const result: Compiled = {
        config: remote({
          collect_interval_seconds: 15,
          host_enabled: false,
          host_collectors: [],
          logs_enabled: false,
          group_id: group,
        }),
        labels,
        tasks: [],
        label_ids: unique(ids),
        task_ids: [],
      },
      c = result.config;
    const old = this.db.get<any>(
      "SELECT config FROM agent_groups WHERE id=?",
      group,
    );
    if (old) {
      const previous = remote(JSON.parse(old.config));
      for (const field of [
        "host_table",
        "probe_table",
        "log_table",
        "collect_interval_seconds",
      ] as const)
        (c as any)[field] = previous[field];
    }
    let host = "",
      probe = "",
      log = "";
    const probes = new Map<string, { owner: string; value: Probe }>(),
      sources = new Map<string, { owner: string; value: LogSource }>(),
      included: Task[] = [];
    const candidates = hostID ? this.effectiveHostTasks(hostID) : this.tasks();
    const customHost = hostID && candidates.some(task => task.type === "host" && task.origin === "custom" && task.enabled);
    for (const t of candidates.filter(task => !(customHost && task.type === "host" && task.origin === "builtin")).sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )) {
      if (!t.enabled || t.type === "script" || (!hostID && !t.label_ids.some((label) => ids.includes(label)))) continue;
      included.push(t);
      result.tasks.push({ id: t.id, name: t.name, type: t.type });
      result.task_ids.push(t.id);
      const conflict = (owner: string, reason: string) =>
        problem(409, `任务“${owner}”与“${t.name}”冲突：${reason}`);
      if (t.type === "host") {
        if (
          host &&
          (c.host_table !== t.config.host_table ||
            c.collect_interval_seconds !== t.config.collect_interval_seconds)
        )
          conflict(host, "指标上报表或采集间隔不同");
        host = t.name;
        c.host_enabled = true;
        c.host_table = t.config.host_table;
        c.collect_interval_seconds = t.config.collect_interval_seconds;
        c.host_collectors.push(...t.config.host_collectors);
        c.process_names.push(...t.config.process_names);
      } else if (t.type === "probe") {
        if (!t.config.probes.length) continue;
        if (probe && c.probe_table !== t.config.probe_table)
          conflict(probe, "拨测上报表不同");
        probe = t.name;
        c.probe_table = t.config.probe_table;
        for (const p of t.config.probes) {
          const previous = probes.get(p.id);
          if (previous) {
            if (goJSON(previous.value) !== goJSON(p))
              conflict(previous.owner, `拨测 ID “${p.id}”重复且参数不同`);
            continue;
          }
          probes.set(p.id, { owner: t.name, value: p });
          c.probes.push(p);
        }
      } else if (t.type === "log") {
        if (!t.config.log_sources.length) continue;
        if (log && c.log_table !== t.config.log_table)
          conflict(log, "日志上报表不同");
        log = t.name;
        c.log_table = t.config.log_table;
        c.logs_enabled = true;
        for (const source of t.config.log_sources) {
          const key = `${clean(source.directory)}\0${source.pattern}\0${source.recursive}`,
            previous = sources.get(key);
          if (previous) {
            if (previous.value.from_beginning !== source.from_beginning)
              conflict(previous.owner, "同一日志来源的首次采集策略不同");
            continue;
          }
          sources.set(key, { owner: t.name, value: source });
          c.log_sources.push(source);
        }
      } else problem(409, `任务“${t.name}”的类型无效`);
    }
    c.host_collectors = unique(c.host_collectors);
    c.process_names = unique(c.process_names);
    c.probes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    c.log_sources.sort((a, b) =>
      goJSON(a) < goJSON(b) ? -1 : goJSON(a) > goJSON(b) ? 1 : 0,
    );
    c.revision = "validate";
    try {
      validateRemote(c);
    } catch (e) {
      problem(
        409,
        "合并任务配置无效：" +
          (e instanceof Error ? e.message : "invalid config"),
      );
    }
    c.revision = "";
    const hash = createHash("sha256")
      .update(
        goJSON({
          Config: wire(c),
          Labels: result.labels,
          Tasks: included.map((t) => ({
            id: t.id,
            name: t.name,
            type: t.type,
            enabled: t.enabled,
            label_ids: t.label_ids,
            config: wire(t.config),
          })),
        }),
      )
      .digest("hex");
    c.revision = hash;
    result.config = wire(c);
    return result;
  }
  validateAll(): void {
    for (const host of this.db.all<{id:string;name:string}>("SELECT id,name FROM managed_machines ORDER BY id")) {
      try { this.compile(this.hostLabels(host.id), "", host.id); }
      catch (error) { if (error instanceof NodeError) problem(error.status, `主机“${host.name}”：${error.message}`); throw error; }
    }
  }
  setLabels(id: string, ids: string[], legacy = ""): void {
    this.db.transaction(() => {
      assertAgentActive(this.db, id);
      const host = this.db.get<{id:string}>("SELECT id FROM managed_machines WHERE agent_id=?", id);
      if (!host || !this.db.get("SELECT 1 FROM agents WHERE id=?", id)) problem(404, "执行节点不存在");
      this.setHostLabels(host!.id, ids, true);
      this.db.run("UPDATE agents SET group_id=? WHERE id=?", legacy || ids[0] || "default", id);
    });
  }
  effective(id: string): Compiled {
    assertAgentActive(this.db, id);
    const node = this.db.get<{ group_id: string }>(
      "SELECT group_id FROM agents WHERE id=?",
      id,
    );
    if (!node) problem(404, "执行节点或任务标签不存在");
    const host = this.db.get<{id:string}>("SELECT id FROM managed_machines WHERE agent_id=?", id);
    if (!host) problem(409, "执行节点未绑定主机");
    return this.compile(this.hostLabels(host!.id), node!.group_id, host!.id);
  }
  nodes(includeRemoved = false): any[] {
    return this.db
      .all<any>(
        "SELECT id,hostname,version,platform,arch,last_seen,heartbeat,group_id,(SELECT m.id FROM managed_machines m WHERE m.agent_id=agents.id ORDER BY m.created_at,m.id LIMIT 1) AS machine_id,(SELECT m.name FROM managed_machines m WHERE m.agent_id=agents.id ORDER BY m.created_at,m.id LIMIT 1) AS machine_name FROM agents WHERE EXISTS (SELECT 1 FROM managed_machines m WHERE m.agent_id=agents.id)" + (includeRemoved ? "" : " AND NOT EXISTS (SELECT 1 FROM agent_lifecycle x WHERE x.agent_id=agents.id AND x.state='removed')") + " ORDER BY last_seen DESC,id",
      )
      .map((node) => {
        node.heartbeat = JSON.parse(node.heartbeat);
        const lifecycle = agentLifecycle(this.db, node.id);
        // Archived assignments are historical metadata, not executable config.
        // Later task edits must not make the history view fail compilation.
        const labelIDs = this.nodeLabels(node.id);
        const compiled: Compiled = lifecycle.lifecycle_state === "removed" ? {
          config: remote({ revision: "", collect_interval_seconds: 15, host_enabled: false, host_collectors: [], logs_enabled: false, group_id: node.group_id }),
          label_ids: labelIDs,
          labels: this.labels().filter(label => labelIDs.includes(label.id)).map(({id,name}) => ({id,name})),
          task_ids: [],
          tasks: [],
        } : this.compile(labelIDs, node.group_id, node.machine_id);
        return {
          ...node,
          ...lifecycle,
          ...compiled,
          group_name:
            compiled.labels.find((l) => l.id === node.group_id)?.name || "",
        };
      });
  }
  group(id: string): any {
    const group = this.db.get<any>(
      "SELECT id,name FROM agent_groups WHERE id=?",
      id,
    );
    if (!group) problem(404, "执行节点或任务标签不存在");
    const label = this.labels().find((l) => l.id === id);
    return {
      id: group.id,
      name: label?.name ?? group.name,
      config: this.compile([id], id).config,
      agent_count: label?.node_count ?? 0,
    };
  }
  groups(): any[] {
    return this.db
      .all<{
        id: string;
      }>("SELECT id FROM agent_groups ORDER BY CASE WHEN id='default' THEN 0 ELSE 1 END,created_at,id")
      .map((row) => this.group(row.id));
  }
  task(input: any, id: string, create: boolean, inTransaction = false): Task {
    const work = () => {
      if (!create && !this.db.get("SELECT 1 FROM agent_tasks WHERE id=?", id)) problem(404, "任务不存在");
      if (create && this.db.get("SELECT 1 FROM agent_tasks WHERE id=?", id)) problem(409, "任务已存在");
      const previous = create ? undefined : this.getTask(id);
      if (create && input.type !== "script") problem(400, "新建任务仅支持自定义脚本");
      if (previous && input.type != null && input.type !== previous.type) problem(400, "不能更改任务类型");
      if (input.origin != null && input.origin !== (previous?.origin ?? "custom")) problem(400, "不能更改任务来源");
      const t = normalizeTask({ ...previous, ...input, id, origin: previous?.origin ?? "custom" });
      if (t.schedule.mode === "at" && t.schedule.run_at !== previous?.schedule.run_at && Date.parse(t.schedule.run_at!) <= this.now().getTime())
        problem(400, "新的指定执行时间必须晚于当前时间");
      this.saveTask(t); this.validateAll();
      // Register timed intent in the same transaction as creation/editing. A
      // near-future deadline may pass before the next five-second scheduler scan.
      if (["at", "cron", "interval"].includes(t.schedule.mode)
        && this.db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_schedules'")) {
        const next = nextTaskDates(t.schedule,this.now(),1)[0];
        if (next) this.db.run("INSERT INTO task_schedules(task_id,fingerprint,next_due) VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET fingerprint=excluded.fingerprint,next_due=excluded.next_due", t.id, t.revision, next);
      }
      return t;
    };
    return inTransaction ? work() : this.db.transaction(work);
  }
  prepareTask(input: any, id: string, create: boolean): Task {
    const rollback = Symbol("validated task preparation");
    let prepared: Task | undefined;
    try {
      this.db.transaction(() => { prepared = this.task(input, id, create, true); throw rollback; });
    } catch (error) { if (error !== rollback) throw error; }
    return prepared!;
  }
  label(name: string, id: string, create: boolean): Label {
    return this.db.transaction(() => {
      if (!validName(name)) problem(400, "请填写任务标签名称，最长 128 字节");
      name = name.trim();
      if (create) {
        this.db.run(
          "INSERT INTO agent_task_labels(id,name,created_at) VALUES(?,?,?)",
          id,
          name,
          this.timestamp(),
        );
        const initial = remote({
          revision: "initial",
          collect_interval_seconds: 15,
          host_enabled: false,
          host_collectors: [],
        });
        this.db.run(
          "INSERT INTO agent_groups(id,name,config,created_at) VALUES(?,?,?,?)",
          id,
          name,
          goJSON(initial),
          this.timestamp(),
        );
      } else {
        if (
          !this.db.run(
            "UPDATE agent_task_labels SET name=? WHERE id=?",
            name,
            id,
          ).changes
        )
          problem(404, "任务标签不存在");
        this.db.run("UPDATE agent_groups SET name=? WHERE id=?", name, id);
      }
      this.validateAll();
      return this.labels().find((label) => label.id === id)!;
    });
  }
  deleteLabel(id: string): void {
    this.db.transaction(() => {
      if (id === "default") problem(409, "默认任务标签不能删除");
      const label = this.labels().find((l) => l.id === id);
      if (!label) problem(404, "任务标签不存在");
      if (label!.host_count + label!.task_count > 0) problem(409, "请先解除主机和任务对该标签的关联");
      this.db.run("DELETE FROM agent_node_labels WHERE label_id=?", id);
      this.db.run("DELETE FROM agent_task_labels WHERE id=?", id);
      this.db.run("DELETE FROM agent_groups WHERE id=?", id);
    });
  }
  deleteTask(id: string): void {
    this.db.transaction(() => {
      if (this.getTask(id).origin === "builtin") problem(409, "平台默认任务不能删除，请停用任务");
      if (this.db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_runs'") && this.db.get("SELECT id FROM task_runs WHERE task_id=? AND (state IN ('queued','running') OR (state='unknown' AND superseded_by='' AND resolved_at='')) LIMIT 1", id)) problem(409, "任务有待执行、运行中或结果未知的记录，请先处理");
      if (!this.db.run("DELETE FROM agent_tasks WHERE id=?", id).changes)
        problem(404, "任务不存在");
      this.validateAll();
    });
  }
  legacyGroup(input: any, id: string, create: boolean): any {
    // The old group endpoint is a label-directory alias only. Native task
    // creation/configuration goes through the persisted task directory.
    if (Object.hasOwn(input, "config")) problem(410, "分组配置写入已移除，请使用任务中心编辑已有任务");
    this.label(input.name, id, create);
    return this.group(id);
  }
  deleteGroup(id: string): void {
    this.deleteLabel(id);
  }
  nodeCount(label: string): number {
    return this.db.get<{ n: number }>(
      "SELECT count(*) AS n FROM machine_host_labels WHERE label_id=?",
      label,
    )!.n;
  }
  heartbeat(id: string, values: any, writeKey: string): { machine_id: string; machine_name: string } {
    const text = (field: string) =>
      values[field] == null ? "" : String(values[field]).trim();
    return this.db.transaction(() => {
      // Recheck under the same writer lock as removal: authentication may have
      // happened before an asynchronous request body or a second centre writer.
      assertAgentActive(this.db, id, 401);
      const old = this.db.get<{ group_id: string }>(
          "SELECT group_id FROM agents WHERE id=?",
          id,
        ),
        group = old?.group_id || text("group_id") || "default";
      if (!old)
        try {
          this.compile([group], group);
        } catch (e) {
          if (e instanceof NodeError)
            problem(
              e.status === 404 ? 400 : e.status,
              "初始任务标签无效或任务冲突，请重新选择标签：" + e.message,
            );
          throw e;
        }
      values = { ...values, runtime_key_id: writeKey };
      delete values.runtime_events;
      this.db.run(
        `INSERT INTO agents(id,host_id,hostname,version,platform,arch,last_seen,heartbeat,group_id) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET hostname=excluded.hostname,version=excluded.version,platform=excluded.platform,arch=excluded.arch,last_seen=excluded.last_seen,heartbeat=excluded.heartbeat`,
        id,
        text("host_id"),
        text("hostname"),
        text("version"),
        text("platform"),
        text("arch"),
        this.timestamp(),
        goJSON(values),
        group,
      );
      return ensureAgentHost(this.db, id, values, this.timestamp());
    });
  }
  events(id: string, writeKey: string, values: any): void {
    const events = values.runtime_events ?? [];
    if (!Array.isArray(events) || events.length > 64)
      throw Error("invalid runtime events");
    this.db.transaction(() => {
      assertAgentActive(this.db, id, 401);
      let pending = this.db.get<{ n: number }>(
        "SELECT count(*) AS n FROM agent_runtime_events",
      )!.n;
      for (const event of events) {
        const at = Date.parse(event?.time);
        if (
          !event ||
          typeof event.id !== "string" ||
          !event.id ||
          length(event.id) > 128 ||
          typeof event.event !== "string" ||
          length(event.event) > 128 ||
          typeof event.body !== "string" ||
          length(event.body) > 1024 ||
          !["INFO", "WARN", "ERROR"].includes(event.severity) ||
          !Number.isFinite(at) ||
          at > this.now().getTime() + 300000 ||
          at < this.now().getTime() - 7 * 864e5
        )
          throw Error("invalid runtime event");
        if (
          !this.db.get(
            "SELECT 1 FROM agent_runtime_events WHERE agent_id=? AND event_id=?",
            id,
            event.id,
          ) &&
          ++pending > 10000
        )
          throw Error("runtime event buffer full");
        this.db.run(
          "INSERT OR IGNORE INTO agent_runtime_events(agent_id,event_id,key_id,payload) VALUES(?,?,?,?)",
          id,
          event.id,
          writeKey,
          goJSON({
            id: event.id,
            time: event.time,
            severity: event.severity,
            event: event.event,
            body: event.body,
          }),
        );
      }
    });
  }
}
