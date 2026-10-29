import { createHash, randomBytes } from "node:crypto";
import { normalize as clean } from "node:path";
import type { DB } from "../shared/types.js";
import { agentLifecycle, assertAgentActive, createAgentLifecycleSchema } from "./agent-lifecycle.js";
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
  name: string;
  type: string;
  enabled: boolean;
  label_ids: string[];
  config: RemoteConfig;
}
export interface Label {
  id: string;
  name: string;
  node_count: number;
  task_count: number;
}
export interface Compiled {
  config: RemoteConfig;
  labels: { id: string; name: string }[];
  tasks: { id: string; name: string; type: string }[];
  label_ids: string[];
  task_ids: string[];
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
function normalizeTask(input: any): Task {
  if (!input || typeof input !== "object" || !validName(input.name))
    problem(400, "请填写任务名称，最长 128 字节");
  if (input.enabled != null && typeof input.enabled !== "boolean")
    problem(400, "任务配置无效");
  const ids = input.label_ids ?? [];
  if (!Array.isArray(ids) || ids.length > 64)
    problem(400, "每个任务最多关联 64 个任务标签");
  if (
    ids.some(
      (id: any) => typeof id !== "string" || !id.trim() || length(id) > 64,
    )
  )
    problem(400, "任务标签无效");
  const t: Task = {
      id: input.id || "",
      name: input.name.trim(),
      type: input.type,
      enabled: input.enabled ?? false,
      label_ids: unique(ids),
      config: remote(input.config ?? {}),
    },
    source = t.config,
    c = remote({
      revision: "validate",
      collect_interval_seconds: 15,
      host_enabled: false,
      host_collectors: [],
      logs_enabled: false,
    });
  if (t.type === "host") {
    Object.assign(c, {
      collect_interval_seconds: source.collect_interval_seconds,
      host_table: source.host_table,
      host_collectors: source.host_collectors,
      process_names: source.process_names,
      host_enabled: true,
    });
  } else if (t.type === "probe")
    Object.assign(c, {
      probe_table: source.probe_table,
      probes: source.probes,
    });
  else if (t.type === "log")
    Object.assign(c, {
      log_table: source.log_table,
      log_sources: source.log_sources,
      logs_enabled: true,
    });
  else problem(400, "任务类型必须是 host、probe 或 log");
  if (t.type === "log" && !c.log_sources.length && !t.enabled)
    c.logs_enabled = false;
  if (t.type === "host" && !c.host_collectors.length && !t.enabled)
    c.host_enabled = false;
  try {
    validateRemote(c);
  } catch (error) {
    problem(
      400,
      "任务配置无效：" +
        (error instanceof Error ? error.message : "invalid config"),
    );
  }
  c.revision = "";
  delete (c as any).group_id;
  t.config = wire(c);
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
    createAgentLifecycleSchema(this.db);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY,host_id TEXT NOT NULL,hostname TEXT NOT NULL,version TEXT NOT NULL,platform TEXT NOT NULL,arch TEXT NOT NULL,last_seen TEXT NOT NULL,heartbeat TEXT NOT NULL,group_id TEXT NOT NULL DEFAULT 'default'); CREATE TABLE IF NOT EXISTS agent_runtime_events(agent_id TEXT NOT NULL,event_id TEXT NOT NULL,key_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(agent_id,event_id)); CREATE TABLE IF NOT EXISTS agent_groups(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,config TEXT NOT NULL,created_at TEXT NOT NULL);`,
    );
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
        `CREATE TABLE IF NOT EXISTS agent_task_migrations(version TEXT PRIMARY KEY,completed_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS agent_task_labels(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS agent_tasks(id TEXT PRIMARY KEY,name TEXT NOT NULL,type TEXT NOT NULL,enabled INTEGER NOT NULL,config TEXT NOT NULL,created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS agent_task_targets(task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,label_id TEXT NOT NULL REFERENCES agent_task_labels(id),PRIMARY KEY(task_id,label_id)); CREATE TABLE IF NOT EXISTS agent_node_labels(agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,label_id TEXT NOT NULL REFERENCES agent_task_labels(id),PRIMARY KEY(agent_id,label_id)); CREATE INDEX IF NOT EXISTS agent_task_targets_label ON agent_task_targets(label_id); CREATE INDEX IF NOT EXISTS agent_node_labels_label ON agent_node_labels(label_id);`,
      );
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
        this.legacyTasks(group.id, name, remote(JSON.parse(group.config)));
      }
      this.db.run(
        "INSERT INTO agent_node_labels(agent_id,label_id) SELECT id,group_id FROM agents",
      );
      this.db.run(
        "INSERT INTO agent_task_migrations(version,completed_at) VALUES('independent-tasks-v1',?)",
        this.timestamp(),
      );
    });
  }
  labels(): Label[] {
    return this.db.all<Label>(
      `SELECT l.id,l.name,(SELECT count(*) FROM agent_node_labels n WHERE label_id=l.id AND NOT EXISTS (SELECT 1 FROM agent_lifecycle x WHERE x.agent_id=n.agent_id AND x.state='removed')) AS node_count,(SELECT count(*) FROM agent_task_targets WHERE label_id=l.id) AS task_count FROM agent_task_labels l ORDER BY CASE WHEN l.id='default' THEN 0 ELSE 1 END,l.created_at,l.id`,
    );
  }
  tasks(): Task[] {
    return this.db
      .all<any>(
        "SELECT id,name,type,enabled,config FROM agent_tasks ORDER BY created_at,id",
      )
      .map((row) => ({
        ...row,
        enabled: !!row.enabled,
        config: wire(normalizeRemote(JSON.parse(row.config))),
        label_ids: this.db
          .all<{
            label_id: string;
          }>("SELECT label_id FROM agent_task_targets WHERE task_id=? ORDER BY label_id", row.id)
          .map((row) => row.label_id),
      }));
  }
  saveTask(t: Task): void {
    this.db.run(
      "INSERT INTO agent_tasks(id,name,type,enabled,config,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,type=excluded.type,enabled=excluded.enabled,config=excluded.config",
      t.id,
      t.name,
      t.type,
      t.enabled,
      goJSON(t.config),
      this.timestamp(),
    );
    this.db.run("DELETE FROM agent_task_targets WHERE task_id=?", t.id);
    for (const label of t.label_ids) {
      if (!this.db.get("SELECT 1 FROM agent_task_labels WHERE id=?", label))
        problem(404, "任务标签不存在：" + label);
      this.db.run(
        "INSERT INTO agent_task_targets(task_id,label_id) VALUES(?,?)",
        t.id,
        label,
      );
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
  nodeLabels(id: string): string[] {
    return this.db
      .all<{
        label_id: string;
      }>("SELECT label_id FROM agent_node_labels WHERE agent_id=? ORDER BY label_id", id)
      .map((row) => row.label_id);
  }
  compile(ids: string[], group = ""): Compiled {
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
    for (const t of this.tasks().sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )) {
      if (!t.enabled || !t.label_ids.some((label) => ids.includes(label)))
        continue;
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
    for (const node of this.db.all<any>(
      "SELECT id,hostname,group_id FROM agents WHERE NOT EXISTS (SELECT 1 FROM agent_lifecycle x WHERE x.agent_id=agents.id AND x.state='removed') ORDER BY id",
    ))
      try {
        this.compile(this.nodeLabels(node.id), node.group_id);
      } catch (e) {
        if (e instanceof NodeError)
          problem(e.status, `执行节点“${node.hostname}”：${e.message}`);
        throw e;
      }
  }
  setLabels(id: string, ids: string[], legacy = ""): void {
    assertAgentActive(this.db, id);
    if (
      !Array.isArray(ids) ||
      ids.length > 64 ||
      ids.some((label) => typeof label !== "string")
    )
      problem(400, "每个执行节点最多关联 64 个任务标签");
    if (!this.db.get("SELECT 1 FROM agents WHERE id=?", id))
      problem(404, "执行节点不存在");
    ids = unique(ids);
    const group = legacy || (ids.length ? ids[0] : "default");
    this.compile(ids, group);
    this.db.run("DELETE FROM agent_node_labels WHERE agent_id=?", id);
    for (const label of ids)
      this.db.run(
        "INSERT INTO agent_node_labels(agent_id,label_id) VALUES(?,?)",
        id,
        label,
      );
    this.db.run("UPDATE agents SET group_id=? WHERE id=?", group, id);
  }
  effective(id: string): Compiled {
    assertAgentActive(this.db, id);
    const node = this.db.get<{ group_id: string }>(
      "SELECT group_id FROM agents WHERE id=?",
      id,
    );
    if (!node) problem(404, "执行节点或任务标签不存在");
    return this.compile(this.nodeLabels(id), node!.group_id);
  }
  nodes(includeRemoved = false): any[] {
    return this.db
      .all<any>(
        "SELECT id,hostname,version,platform,arch,last_seen,heartbeat,group_id FROM agents" + (includeRemoved ? "" : " WHERE NOT EXISTS (SELECT 1 FROM agent_lifecycle x WHERE x.agent_id=agents.id AND x.state='removed')") + " ORDER BY last_seen DESC,id",
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
        } : this.compile(labelIDs, node.group_id);
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
  guardLegacy(label: string): void {
    for (const task of this.tasks()) {
      const expected = ["host", "probe", "log"].find(
        (kind) => task.id === `legacy:${label}:${kind}`,
      );
      if (expected) {
        if (
          task.type !== expected ||
          task.label_ids.length !== 1 ||
          task.label_ids[0] !== label
        )
          problem(409, "迁移任务已独立调整，请在任务管理中修改配置");
      } else if (task.label_ids.includes(label))
        problem(409, "该任务标签已使用独立任务，请在任务管理中修改配置");
    }
  }
  task(input: any, id: string, create: boolean): Task {
    return this.db.transaction(() => {
      if (!create && !this.db.get("SELECT 1 FROM agent_tasks WHERE id=?", id))
        problem(404, "任务不存在");
      const t = normalizeTask({ ...input, id });
      this.saveTask(t);
      this.validateAll();
      return t;
    });
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
      if (label!.node_count + label!.task_count > 0)
        problem(409, "请先解除执行节点和任务对该标签的关联");
      this.db.run("DELETE FROM agent_task_labels WHERE id=?", id);
      this.db.run("DELETE FROM agent_groups WHERE id=?", id);
    });
  }
  deleteTask(id: string): void {
    this.db.transaction(() => {
      if (!this.db.run("DELETE FROM agent_tasks WHERE id=?", id).changes)
        problem(404, "任务不存在");
      this.validateAll();
    });
  }
  legacyGroup(input: any, id: string, create: boolean): any {
    return this.db.transaction(() => {
      if (!validName(input.name))
        problem(400, "请填写任务标签名称，最长 128 字节");
      let c = remote({ collect_interval_seconds: 15 });
      if (!create) {
        const saved = this.db.get<{ config: string }>(
          "SELECT config FROM agent_groups WHERE id=?",
          id,
        );
        if (!saved) problem(404, "执行节点或任务标签不存在");
        c = remote(JSON.parse(saved!.config));
        if (input.config != null) this.guardLegacy(id);
      }
      if (input.config != null) c = remote(input.config);
      delete (c as any).group_id;
      c.revision = nodeID();
      try {
        validateRemote(c);
      } catch (e) {
        problem(
          400,
          "任务配置无效：" +
            (e instanceof Error ? e.message : "invalid config"),
        );
      }
      const name = input.name.trim();
      if (create) {
        this.db.run(
          "INSERT INTO agent_groups(id,name,config,created_at) VALUES(?,?,?,?)",
          id,
          name,
          goJSON(c),
          this.timestamp(),
        );
        this.db.run(
          "INSERT INTO agent_task_labels(id,name,created_at) VALUES(?,?,?)",
          id,
          name,
          this.timestamp(),
        );
      } else {
        this.db.run(
          "UPDATE agent_groups SET name=?,config=? WHERE id=?",
          name,
          goJSON(c),
          id,
        );
        this.db.run("UPDATE agent_task_labels SET name=? WHERE id=?", name, id);
      }
      if (create || input.config != null) this.legacyTasks(id, name, c);
      this.validateAll();
      return this.group(id);
    });
  }
  deleteGroup(id: string): void {
    this.db.transaction(() => {
      if (id === "default") problem(409, "默认任务标签不能删除");
      if (!this.db.get("SELECT 1 FROM agent_groups WHERE id=?", id))
        problem(404, "任务标签不存在");
      if (this.nodeCount(id))
        problem(409, "请先解除执行节点与该任务标签的关联");
      this.guardLegacy(id);
      const ids = ["host", "probe", "log"].map(
        (kind) => `legacy:${id}:${kind}`,
      );
      if (
        this.db.get(
          "SELECT 1 FROM agent_task_targets WHERE label_id=? AND task_id NOT IN (?,?,?)",
          id,
          ...ids,
        )
      )
        problem(409, "请先解除任务与该标签的关联");
      if (
        this.db.get(
          "SELECT 1 FROM agent_task_targets WHERE label_id<>? AND task_id IN (?,?,?)",
          id,
          ...ids,
        )
      )
        problem(409, "原迁移任务已关联其他任务标签，请在任务管理中调整后重试");
      this.db.run("DELETE FROM agent_tasks WHERE id IN (?,?,?)", ...ids);
      this.db.run("DELETE FROM agent_task_labels WHERE id=?", id);
      this.db.run("DELETE FROM agent_groups WHERE id=?", id);
    });
  }
  nodeCount(label: string): number {
    return this.db.get<{ n: number }>(
      "SELECT count(*) AS n FROM agent_node_labels WHERE label_id=?",
      label,
    )!.n;
  }
  heartbeat(id: string, values: any, writeKey: string): void {
    const text = (field: string) =>
      values[field] == null ? "" : String(values[field]).trim();
    this.db.transaction(() => {
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
      if (!old)
        this.db.run(
          "INSERT INTO agent_node_labels(agent_id,label_id) VALUES(?,?)",
          id,
          group,
        );
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
