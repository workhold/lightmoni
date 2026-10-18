import { createHash } from "node:crypto";
import type {
  Context,
  Dependencies,
  Handler,
  Module,
  WriteKey,
} from "../shared/types.js";
import { HTTPError } from "../shared/http.js";
import { parseNanoTime, formatNanoTime } from "../shared/otlp.js";
import type { Normalized } from "./ingest.js";
import {
  NodeError,
  NodeStore,
  nodeID,
  unique,
  validName,
} from "./nodes-model.js";
import type { AgentCredentialStore } from "./agent-credentials.js";
export interface NodesOptions {
  internalExporter?: (
    table: string,
    rows: Normalized[],
    batch?: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  telemetryInterval?: number;
  agentCredentials?: AgentCredentialStore;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const record = (value: any): value is Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value);
const stamp = (value: string) => {
  const text = formatNanoTime(parseNanoTime(value));
  return (
    text.slice(0, -1).replace("T", " ").split(".")[0] +
    "." +
    (text.match(/\.(\d+)/)?.[1] ?? "").padEnd(9, "0")
  );
};
const number = (value: any) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

export function registerNodes(
  deps: Dependencies,
  options: NodesOptions = {},
): Module & { publishTelemetry: () => Promise<void> } {
  const store = new NodeStore(deps.db, deps.now),
    router = deps.router,
    base = "/api/v1",
    sent = new Map<string, string>(),
    controller = new AbortController();
  let timer: NodeJS.Timeout | undefined, inflight: Promise<void> | undefined;
  const safe =
    (handler: Handler): Handler =>
    async (ctx) => {
      try {
        await handler(ctx);
      } catch (e) {
        if (e instanceof NodeError || e instanceof HTTPError)
          ctx.json({ error: e.message }, e.status);
        else if (
          e instanceof Error &&
          /UNIQUE constraint failed/.test(e.message)
        )
          ctx.json({ error: "任务标签名称已存在" }, 409);
        else ctx.json({ error: "执行节点任务暂不可用" }, 500);
      }
    };
  const admin = (ctx: Context) => {
    if (ctx.user.role !== "admin") throw new NodeError(403, "需要管理员权限");
  };
  const body = async (ctx: Context) => {
    try {
      const value = await ctx.body();
      if (!record(value)) throw Error();
      return value;
    } catch {
      throw new NodeError(400, "任务配置无效");
    }
  };
  const key = (ctx: Context, agentID: string): WriteKey => {
    if (options.agentCredentials?.has(agentID, "control")) {
      const credential = options.agentCredentials.authenticate(
        ctx.req,
        agentID,
        "control",
      );
      return {
        id: credential.credential_id,
        name: "agent:" + agentID,
        allowed_tables: [],
        allow_all_tables: true,
      };
    }
    try {
      return deps.auth.validateKey(ctx);
    } catch {
      throw new NodeError(401, "invalid write key");
    }
  };
  router.get(
    base + "/agents",
    safe((ctx) => ctx.json(store.nodes())),
  );
  router.get(
    base + "/agent-task-labels",
    safe((ctx) => ctx.json(store.labels())),
  );
  const label: Handler = async (ctx) => {
    admin(ctx);
    const input = await body(ctx),
      create = ctx.req.method === "POST",
      id = create ? nodeID() : ctx.params.id;
    if (!validName(input.name))
      throw new NodeError(400, "请填写任务标签名称，最长 128 字节");
    ctx.json(store.label(input.name, id, create), create ? 201 : 200);
  };
  router.post(base + "/agent-task-labels", safe(label));
  router.put(base + "/agent-task-labels/:id", safe(label));
  router.delete(
    base + "/agent-task-labels/:id",
    safe((ctx) => {
      admin(ctx);
      store.deleteLabel(ctx.params.id);
      ctx.json({ ok: true });
    }),
  );
  router.get(
    base + "/agent-tasks",
    safe((ctx) => ctx.json(store.tasks())),
  );
  const task: Handler = async (ctx) => {
    admin(ctx);
    const input = await body(ctx),
      create = ctx.req.method === "POST";
    ctx.json(
      store.task(input, create ? nodeID() : ctx.params.id, create),
      create ? 201 : 200,
    );
  };
  router.post(base + "/agent-tasks", safe(task));
  router.put(base + "/agent-tasks/:id", safe(task));
  router.delete(
    base + "/agent-tasks/:id",
    safe((ctx) => {
      admin(ctx);
      store.deleteTask(ctx.params.id);
      ctx.json({ ok: true });
    }),
  );
  router.put(
    base + "/agents/:id/labels",
    safe(async (ctx) => {
      admin(ctx);
      const input = await body(ctx);
      if (!Array.isArray(input.label_ids))
        throw new NodeError(400, "请提供任务标签列表，可为空数组");
      deps.db.transaction(() =>
        store.setLabels(ctx.params.id, input.label_ids),
      );
      ctx.json({ label_ids: unique(input.label_ids) });
    }),
  );
  router.get(
    base + "/agent-groups",
    safe((ctx) => ctx.json(store.groups())),
  );
  const group: Handler = async (ctx) => {
    admin(ctx);
    const input = await body(ctx),
      create = ctx.req.method === "POST";
    ctx.json(
      store.legacyGroup(input, create ? nodeID() : ctx.params.group, create),
      create ? 201 : 200,
    );
  };
  router.post(base + "/agent-groups", safe(group));
  router.put(base + "/agent-groups/:group", safe(group));
  router.delete(
    base + "/agent-groups/:group",
    safe((ctx) => {
      admin(ctx);
      store.deleteGroup(ctx.params.group);
      ctx.json({ ok: true });
    }),
  );
  router.put(
    base + "/agents/:id/group",
    safe(async (ctx) => {
      admin(ctx);
      const input = await body(ctx);
      if (typeof input.group_id !== "string" || !input.group_id)
        throw new NodeError(400, "请选择初始任务标签");
      deps.db.transaction(() =>
        store.setLabels(ctx.params.id, [input.group_id], input.group_id),
      );
      ctx.json(store.group(input.group_id));
    }),
  );
  const heartbeat: Handler = async (ctx) => {
    const values = await body(ctx),
      id =
        ctx.params.id ||
        (values.agent_id == null ? "" : String(values.agent_id));
    if (!id) throw new NodeError(400, "agent_id required");
    const writeKey = key(ctx, id);
    try {
      store.events(id, writeKey.id, values);
    } catch {
      throw new NodeError(503, "执行节点运行事件暂不可用");
    }
    try {
      store.heartbeat(id, values, writeKey.id);
    } catch (e) {
      if (e instanceof NodeError) throw e;
      throw new NodeError(503, "执行节点记录暂不可用");
    }
    ctx.json({ agent_id: id, ok: true });
  };
  router.post(base + "/agents/register", safe(heartbeat), { public: true });
  router.post(base + "/agents/:id/heartbeat", safe(heartbeat), {
    public: true,
  });
  router.get(
    base + "/agents/:id/config",
    safe((ctx) => {
      key(ctx, ctx.params.id);
      const compiled = store.effective(ctx.params.id);
      ctx.json({
        ...compiled.config,
        task_ids: compiled.task_ids,
        task_labels: compiled.labels,
      });
    }),
    { public: true },
  );
  const exportRows = async (rows: Normalized[], batch: string) => {
    if (options.internalExporter) {
      await options.internalExporter(
        "lightmoni_agent",
        rows,
        batch,
        controller.signal,
      );
      return;
    }
    for (const kind of ["metric", "log"]) {
      const selected = rows.filter((row) => row.kind === kind);
      if (!selected.length) continue;
      if (!deps.cat.ensure) throw Error("telemetry catalog unavailable");
      const subtype = kind === "metric" ? "gauge" : "";
      await (deps.cat.ensure as any)(
        "lightmoni_agent",
        kind,
        subtype,
        "lightmoni-agent",
        controller.signal,
      );
      await deps.ch.insert(
        "_lm_" +
          (kind === "metric"
            ? "metric_lightmoni_agent_gauge"
            : "log_lightmoni_agent"),
        selected.map((row) => row.row),
        controller.signal,
      );
    }
  };
  const runtimeRow = (
    id: string,
    host: string,
    writeKey: string,
    group: string,
    at: string,
    identity: string,
  ) => {
    const resource = {
        "service.name": "lightmoni-agent",
        "service.instance.id": id,
        "host.id": host,
        "lightmoni.agent_id": id,
      },
      attributes: Record<string, string> = {
        "lightmoni.component": "agent",
        group_id: group,
      };
    return {
      event_id: hash(identity),
      event_time: stamp(at),
      ingested_at: stamp(deps.now().toISOString()),
      service: "lightmoni-agent",
      instance_id: id,
      host_id: host,
      agent_id: id,
      key_id: writeKey,
      resource_json: JSON.stringify(resource),
      attributes,
      attributes_json: JSON.stringify(attributes),
    };
  };
  const publish = async () => {
    for (const node of deps.db.all<any>(
      "SELECT id,host_id,last_seen,heartbeat,group_id FROM agents",
    )) {
      const signature = node.last_seen + "/" + node.group_id;
      if (sent.get(node.id) === signature) continue;
      let heartbeat: any;
      try {
        parseNanoTime(node.last_seen);
        heartbeat = JSON.parse(node.heartbeat);
      } catch {
        continue;
      }
      const values: Record<string, number> = {
          heartbeat: 1,
          queue_batches: number(heartbeat.queue_batches),
          queue_bytes: number(heartbeat.queue_bytes),
          quarantine_batches: number(heartbeat.quarantine_batches),
          oldest_age_seconds: number(heartbeat.oldest_age_seconds),
          collector_errors: record(heartbeat.collectors_status)
            ? Object.values(heartbeat.collectors_status).filter(
                (value) => value !== "ok" && value !== "disabled",
              ).length
            : 0,
        },
        metrics: Normalized[] = [];
      for (const [name, value] of Object.entries(values)) {
        const row = runtimeRow(
          node.id,
          node.host_id,
          String(heartbeat.runtime_key_id ?? ""),
          node.group_id,
          node.last_seen,
          node.id + signature + name,
        );
        row.attributes.heartbeat_timeout_seconds = String(
          Math.max(90, 3 * number(heartbeat.control_interval_seconds)),
        );
        Object.assign(row, {
          name: "lightmoni.agent." + name,
          unit: "",
          start_time: row.event_time,
          value,
          value_type: "double",
          value_int: null,
          value_float: value,
          attributes_json: JSON.stringify(row.attributes),
        });
        metrics.push({ kind: "metric", subtype: "gauge", row });
      }
      await exportRows(metrics, "agent-heartbeat/" + hash(node.id + signature));
      sent.set(node.id, signature);
    }
    for (const entry of deps.db.all<any>(
      `SELECT e.agent_id,e.event_id,e.key_id,e.payload,COALESCE(a.host_id,'') AS host_id,COALESCE(a.group_id,'default') AS group_id FROM agent_runtime_events e LEFT JOIN agents a ON a.id=e.agent_id ORDER BY e.rowid LIMIT 256`,
    )) {
      const event = JSON.parse(entry.payload),
        row = runtimeRow(
          entry.agent_id,
          entry.host_id,
          entry.key_id,
          entry.group_id,
          event.time,
          entry.agent_id + "/" + event.id,
        );
      row.attributes.event = event.event;
      Object.assign(row, {
        severity: event.severity,
        severity_number: ({ INFO: 9, WARN: 13, ERROR: 17 } as any)[
          event.severity
        ],
        body: event.body,
        body_json: JSON.stringify(event.body),
        source_id: entry.agent_id,
        source_seq: null,
        trace_id: "",
        span_id: "",
        attributes_json: JSON.stringify(row.attributes),
      });
      await exportRows(
        [{ kind: "log", subtype: "", row }],
        "agent-runtime/" + hash(entry.agent_id + "/" + entry.event_id),
      );
      deps.db.run(
        "DELETE FROM agent_runtime_events WHERE agent_id=? AND event_id=?",
        entry.agent_id,
        entry.event_id,
      );
    }
  };
  const publishTelemetry = (): Promise<void> => {
    inflight ??= publish().finally(() => {
      inflight = undefined;
    });
    return inflight;
  };
  const tick = () => {
    void publishTelemetry().catch(() => {
      if (!controller.signal.aborted)
        deps.logger.warn("Agent runtime telemetry export failed");
    });
  };
  return {
    publishTelemetry,
    start() {
      tick();
      timer = setInterval(tick, options.telemetryInterval ?? 10000);
      timer.unref();
    },
    async close() {
      if (timer) clearInterval(timer);
      controller.abort();
      await inflight?.catch(() => {});
    },
  };
}
