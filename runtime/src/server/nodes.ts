import { applicationTargets } from "../shared/application-observation.js";
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
import { agentLifecycle, assertAgentActive, isAgentRemoved } from "./agent-lifecycle.js";
import { hasActiveTaskRuns } from "./agent-hosts.js";
import { assertNoPendingAgentUpdate } from "./machine-agent-updates-guard.js";
import { observeNetworkSource, trustedProxyMatcher } from "./host-network.js";
export interface NodesOptions {
  internalExporter?: (
    table: string,
    rows: Normalized[],
    batch?: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  telemetryInterval?: number;
  agentCredentials?: AgentCredentialStore;
  trustedProxies?: string[];
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
  const trustedProxy = trustedProxyMatcher(options.trustedProxies);
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
    assertAgentActive(deps.db, agentID, 401);
    if (!options.agentCredentials) throw new NodeError(401, "独立 Agent control 凭据未配置");
    const credential = options.agentCredentials.authenticate(ctx.req, agentID, "control");
    return { id: credential.credential_id, name: "agent:" + agentID, allowed_tables: [], allow_all_tables: true };
  };
  router.get(
    base + "/agents",
    safe((ctx) => {
      const includeRemoved = ctx.url.searchParams.get("include_removed") === "true";
      if (includeRemoved) admin(ctx);
      ctx.json(store.nodes(includeRemoved));
    }),
  );
  router.post(base + "/agents/:id/remove", safe(async (ctx) => {
    admin(ctx);
    const input = await body(ctx);
    if (input.confirm !== true) throw new NodeError(400, "必须明确确认移除节点");
    if (Object.keys(input).some(field => !["confirm", "reason"].includes(field))
      || (input.reason != null && (typeof input.reason !== "string" || Buffer.byteLength(input.reason) > 512)))
      throw new NodeError(400, "移除原因无效，最长 512 字节");
    const agentID = ctx.params.id, reason = (input.reason ?? "").trim();
    const table = (name: string) => Boolean(deps.db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", name));
    const lifecycle = deps.db.transaction(() => {
      if (!deps.db.get("SELECT id FROM agents WHERE id=?", agentID)) throw new NodeError(404, "执行节点不存在");
      if (isAgentRemoved(deps.db, agentID)) return agentLifecycle(deps.db, agentID);
      assertNoPendingAgentUpdate(deps.db, agentID);
      if (hasActiveTaskRuns(deps.db, agentID)) throw new NodeError(409, "节点有待执行、运行中或结果未知的任务中心记录，请先处理");
      if (table("agent_jobs") && deps.db.get("SELECT id FROM agent_jobs WHERE agent_id=? AND state NOT IN ('succeeded','failed','cancelled') LIMIT 1", agentID))
        throw new NodeError(409, "节点有待执行、运行中或结果未知的任务，请先完成或核对");
      if (table("machine_uninstallations") && deps.db.get("SELECT id FROM machine_uninstallations WHERE agent_id=? AND status IN ('awaiting_approval','running','unknown') LIMIT 1", agentID))
        throw new NodeError(409, "节点有待审批、运行中或结果未知的卸载，请先取消或核对");
      const audiences = table("agent_credentials") ? deps.db.all<{audience:string}>("SELECT DISTINCT audience FROM agent_credentials WHERE agent_id=?", agentID).map(row => row.audience) : [];
      if (!audiences.includes("control") || !audiences.includes("data"))
        throw new NodeError(409, "此节点使用共享上报 Key，需先迁移到独立 control/data 凭据后才能完整移除；共享 SDK Key 保持有效");
      const at = deps.now().toISOString();
      deps.db.run("INSERT INTO agent_lifecycle(agent_id,state,removed_at,removed_by,removal_reason) VALUES(?,'removed',?,?,?)", agentID, at, ctx.user.id, reason);
      const revoked = deps.db.run("UPDATE agent_credentials SET revoked_at=?,revoke_reason=? WHERE agent_id=? AND revoked_at IS NULL", at, "节点已移除" + (reason ? ": " + reason : ""), agentID).changes;
      deps.db.run("INSERT INTO agent_lifecycle_events(id,agent_id,event,actor_id,occurred_at,reason,revoked_credentials) VALUES(?,?,'removed',?,?,?,?)", nodeID(), agentID, ctx.user.id, at, reason, revoked);
      return agentLifecycle(deps.db, agentID);
    });
    ctx.json({ agent_id: agentID, ...lifecycle, credentials_revoked: true, remote_uninstalled: false });
  }));
  router.get(base + "/task-hosts", safe(ctx => ctx.json(store.hostDirectory())));
  router.get(base + "/host-labels", safe(ctx => ctx.json(store.labels())));
  router.post(base + "/host-labels", safe(async ctx => {
    admin(ctx); const input = await body(ctx);
    ctx.json(store.label(input.name, nodeID(), true), 201);
  }));
  router.put(base + "/host-labels/:id", safe(async ctx => {
    admin(ctx); const input = await body(ctx); ctx.json(store.label(input.name, ctx.params.id, false));
  }));
  router.delete(base + "/host-labels/:id", safe(ctx => { admin(ctx); store.deleteLabel(ctx.params.id); ctx.json({ok:true}); }));
  router.get(base + "/machines/:id/labels", safe(ctx => {
    const label_ids = store.hostLabels(ctx.params.id);
    ctx.json({ label_ids, labels: store.labels().filter(label => label_ids.includes(label.id)).map(({id,name}) => ({id,name})) });
  }));
  router.put(base + "/machines/:id/labels", safe(async ctx => {
    admin(ctx); const input = await body(ctx);
    if (Object.keys(input).some(key => key !== "label_ids")) throw new NodeError(400, "主机标签请求无效");
    const label_ids = store.setHostLabels(ctx.params.id, input.label_ids);
    ctx.json({ label_ids, labels: store.labels().filter(label => label_ids.includes(label.id)).map(({id,name}) => ({id,name})) });
  }));
  router.get(base + "/machines/:id/tasks", safe(ctx => ctx.json(store.effectiveHostTasks(ctx.params.id))));
  router.put(base + "/machines/:id/task-overrides/:taskId", safe(async ctx => {
    admin(ctx); ctx.json(store.setOverride(ctx.params.id, ctx.params.taskId, await body(ctx)));
  }));
  router.delete(base + "/machines/:id/task-overrides/:taskId", safe(ctx => {
    admin(ctx); ctx.json(store.clearOverride(ctx.params.id, ctx.params.taskId));
  }));
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
      store.setLabels(ctx.params.id, input.label_ids);
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
      store.setLabels(ctx.params.id, [input.group_id], input.group_id);
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
    } catch (e) {
      if (e instanceof NodeError || e instanceof HTTPError) throw e;
      throw new NodeError(503, "执行节点运行事件暂不可用");
    }
    let machine: { machine_id: string; machine_name: string };
    try {
      machine = store.heartbeat(id, values, writeKey.id, observeNetworkSource(ctx.req, trustedProxy));
    } catch (e) {
      if (e instanceof NodeError || e instanceof HTTPError) throw e;
      throw new NodeError(503, "执行节点记录暂不可用");
    }
    ctx.json({ agent_id: id, ...machine, ok: true, application_targets: applicationTargets(deps.db, id, deps.decrypt) });
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
        "lightmoni",
        kind,
        subtype,
        "lightmoni-agent",
        controller.signal,
      );
      await deps.ch.insert(
        "_lm_" +
          (kind === "metric"
            ? "lightmoni_metric_gauge"
            : "lightmoni_log"),
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
      "SELECT id,host_id,last_seen,heartbeat,group_id FROM agents WHERE NOT EXISTS (SELECT 1 FROM agent_lifecycle x WHERE x.agent_id=agents.id AND x.state='removed')",
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
