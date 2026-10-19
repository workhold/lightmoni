import { parseJSON } from "../shared/json.js";
import type { Context } from "../shared/types.js";
import type { Alerts } from "./alerts.js";
import { AlertCapabilities, normalizeRule, validateRule } from "./alert-capabilities.js";
export { validateRule } from "./alert-capabilities.js";
import {
  bytes,
  clone,
  encode,
  guarded,
  guardedAsync,
  hash,
  id,
  parseTime,
  stamp,
  normalizeStamp,
  unique,
  validRange,
} from "./common.js";
import {
  defaultPolicies,
  onCall,
  policy,
  priority,
  validatePolicyGroup,
  localParts,
  zonedDate,
} from "./alert-policy.js";
import {
  channelTypes,
  rateKey,
  recipientKey,
  secretFields,
  validateChannel,
  validateRecipient,
} from "./alert-notify.js";
import {
  registerDirectory,
  traceDetail,
} from "./alert-evidence.js";
async function filteredIDs(
  m: Alerts,
  c: Context,
  rules = m.rules(),
): Promise<Set<string>> {
  const q = c.url.searchParams,
    tables = await m.deps.cat.list(c.signal);
  return new Set(
    rules
      .filter((v) => {
        if (
          (q.get("rule_id") && q.get("rule_id") !== v.id) ||
          (q.get("table_id") &&
            !v.source_table_ids?.includes(q.get("table_id"))) ||
          (q.get("service") &&
            v.services?.length &&
            !v.services.includes(q.get("service"))) ||
          (q.get("enabled") && String(v.enabled) !== q.get("enabled"))
        )
          return false;
        const gid = q.get("group_id");
        return (
          !gid ||
          v.group_ids?.includes(gid) ||
          (!v.group_ids?.length &&
            tables.some(
              (t) =>
                v.source_table_ids?.includes(t.id) && t.alert_group_id === gid,
            ))
        );
      })
      .map((v) => v.id),
  );
}
const incident = (m: Alerts, c: Context): any => {
  const v = m.response(c.params.id);
  if (!v) c.error(404, "事件不存在");
  return v;
};
const canRespond = (m: Alerts, r: any, c: Context) =>
  c.user.role === "admin" || m.group(r.group_id)?.members?.includes(c.user.id);
function resetPaging(v: any, m: Alerts): void {
  Object.assign(v, {
    state: "unclaimed",
    owner_id: "",
    owner_name: "",
    ack_at: "",
    ack_method: "",
    handling_until: "",
    exhausted: false,
    round: 0,
    stage_round: 0,
    successful_rounds: 0,
    counted_round: 0,
    level_active_seconds: 0,
    since_round_seconds: 0,
    last_tick: stamp(m.now()),
    generation: v.generation + 1,
  });
}
export function registerAlertAPI(m: Alerts): void {
  const { router: r, db } = m.deps;
  const capabilities = new AlertCapabilities(m);
  r.get("/api/v1/alerts/groups", (c) => c.json(m.groups()));
  const saveGroup = async (c: Context) => {
    const g = await c.body<any>();
    g.name = String(g.name ?? "").trim();
    g.members ??= [];
    g.targets ??= [];
    g.primary ??= [];
    g.backup ??= [];
    g.fallback ??= [];
    g.channel_ids ??= [];
    if (
      c.req.method === "POST" &&
      g.members.length &&
      !Object.keys(g.policies ?? {}).length
    )
      g.policies = defaultPolicies();
    guarded(c, () =>
      validatePolicyGroup(
        g,
        (key) => m.member(key),
        (key) => m.channel(key),
      ),
    );
    if (!g.name) c.error(400, "告警组名称不能为空");
    if (g.targets.length > 100) c.error(400, "最多100个通知目标");
    const seen = new Set<string>();
    for (const t of g.targets) {
      const ch = m.channel(t.channel_id);
      if (!ch) c.error(400, "通知渠道不存在");
      guarded(c, () => validateRecipient(ch.type, t.recipient));
      const key = t.channel_id + recipientKey(t.recipient);
      if (seen.has(key)) c.error(400, "重复通知目标");
      seen.add(key);
    }
    g.id = c.params.id || id();
    const old = m.group(g.id);
    if (old && old.revision !== g.revision)
      c.error(409, "告警组已更新，请刷新后重试");
    g.revision = (old?.revision || 0) + 1;
    db.run(
      "INSERT INTO alert_groups(id,name,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,body=excluded.body",
      g.id,
      g.name,
      encode(g),
    );
    c.json(g);
  };
  r.post("/api/v1/alerts/groups", saveGroup);
  r.put("/api/v1/alerts/groups/:id", saveGroup);
  r.delete("/api/v1/alerts/groups/:id", async (c) => {
    if (
      (await m.deps.cat.list(c.signal)).some(
        (t) => t.alert_group_id === c.params.id,
      )
    )
      c.error(409, "请先解除数据表的告警组绑定");
    if (m.rules().some((v) => v.group_ids?.includes(c.params.id)))
      c.error(409, "请先解除图表或告警规则的告警组绑定");
    db.run("DELETE FROM alert_groups WHERE id=?", c.params.id);
    c.json({ ok: true });
  });
  r.get("/api/v1/notify/channels", (c) =>
    c.json(m.list("SELECT body FROM alert_channels ORDER BY name")),
  );
  const saveChannel = async (c: Context) => {
    m.deps.auth.requireAdmin(c);
    const v = await c.body<any>();
    if (!v.name?.trim() || !channelTypes.has(v.type))
      c.error(400, "invalid notification channel");
    v.id = c.params.id || id();
    v.config ??= {};
    const old = m.channel(v.id, true);
    if (old && old.revision !== v.revision)
      c.error(409, "通知渠道已更新，请刷新后重试");
    v.revision = (old?.revision || 0) + 1;
    const sec: Record<string, string> = {};
    if (old?.type === v.type)
      for (const [k, value] of Object.entries<string>(old.config))
        if (secretFields.has(k)) sec[k] = value;
    for (const [k, value] of Object.entries<any>(v.config)) {
      if (typeof value !== "string") c.error(400, "渠道配置值必须为字符串");
      if (secretFields.has(k)) {
        if (value) sec[k] = value;
        delete v.config[k];
      }
    }
    if (
      ["aliyun_voice", "tencent_voice", "feishu_app"].includes(v.type) &&
      !sec.callback_token
    )
      sec.callback_token = id() + id();
    const config = { ...v.config, ...sec };
    guarded(c, () => validateChannel(v.type, config));
    v.has_secret = !!Object.keys(sec).length;
    const cipher = m.deps.encrypt(encode(sec));
    db.transaction(() => {
      db.run(
        "INSERT INTO alert_channels(id,name,body,secret) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,body=excluded.body,secret=excluded.secret",
        v.id,
        v.name,
        encode(v),
        cipher,
      );
      const changed =
        old &&
        (old.type !== v.type ||
          [
            "url",
            "endpoint",
            "token",
            "push_channel",
            "host",
            "port",
            "tls",
            "username",
            "from",
            "access_key_id",
            "access_key_secret",
            "secret_id",
            "secret_key",
            "app_key",
            "app_secret",
            "sdk_app_id",
            "region",
            "sign_name",
            "template_code",
            "template_id",
            "template_params",
            "called_show_number",
            "sender",
            "signature",
            "play_times",
          ].some((k) => old.config[k] !== config[k]));
      if (changed || !v.enabled)
        db.run(
          "UPDATE alert_outbox SET status='cancelled' WHERE channel_id=? AND status IN ('queued','retry')",
          v.id,
        );
      db.run(
        "DELETE FROM alert_rate_blocks WHERE rate_key=? OR rate_key=?",
        rateKey(old),
        rateKey({ type: v.type, config }),
      );
    });
    c.json(v);
  };
  r.post("/api/v1/notify/channels", saveChannel);
  r.put("/api/v1/notify/channels/:id", saveChannel);
  r.delete("/api/v1/notify/channels/:id", (c) => {
    m.deps.auth.requireAdmin(c);
    if (
      m
        .groups()
        .some(
          (g) =>
            g.channel_ids?.includes(c.params.id) ||
            g.targets?.some((t: any) => t.channel_id === c.params.id),
        )
    )
      c.error(409, "请先解除告警组中的通知接入引用");
    db.run("DELETE FROM alert_channels WHERE id=?", c.params.id);
    c.json({ ok: true });
  });
  r.post("/api/v1/notify/channels/:id/test", async (c) => {
    const input = await c.body<any>(),
      ch = m.channel(c.params.id);
    if (!ch) c.error(404, "channel not found");
    guarded(c, () => validateRecipient(ch.type, input.recipient));
    const time = stamp(m.now()),
      event = {
        id: id(),
        kind: "test",
        created_at: time,
        rule_name: "LightMoni 测试通知",
        message: "这是一条由你发起的通知渠道测试。",
      },
      d = {
        id: id(),
        event_id: event.id,
        channel_id: ch.id,
        recipient: input.recipient,
        status: "queued",
        created_at: time,
        updated_at: time,
        next_attempt: time,
        payload: event,
        attempts: 0,
      };
    m.queue(d);
    c.json(d);
  });
  r.get("/api/v1/notify/channels/:id/callback-url", (c) => {
    m.deps.auth.requireAdmin(c);
    const ch = m.channel(c.params.id, true);
    if (!ch) c.error(404, "渠道不存在");
    if (!ch.config.callback_token) c.error(400, "此渠道没有回调能力");
    c.json({
      url:
        m.deps.externalURL.replace(/\/$/, "") +
        "/api/v1/notify/callbacks/" +
        ch.id +
        "/" +
        ch.config.callback_token,
    });
  });
  r.post(
    "/api/v1/notify/callbacks/:id/:token",
    (c) => m.notifications.callback(c),
    { public: true },
  );
  r.get("/api/v1/alerts/rules", async (c) => {
    c.json(await capabilities.listRules(c.user, Object.fromEntries(c.url.searchParams)));
  });
  r.get("/api/v1/alerts/rules/:id", (c) => c.json(capabilities.getRule(c.user, c.params.id)));
  const saveRule = async (c: Context) => {
    const awaitBody = await c.body<any>();
    const prepared = await guardedAsync(c, () => capabilities.prepareRuleSave(c.user, awaitBody, c.params.id, c.signal));
    c.json(db.transaction(() => capabilities.commitRuleSave(c.user, prepared)));
  };
  r.post("/api/v1/alerts/rules", saveRule);
  r.put("/api/v1/alerts/rules/:id", saveRule);
  r.delete("/api/v1/alerts/rules/:id", (c) => {
    db.transaction(() => {
      db.run("DELETE FROM alert_rules WHERE id=?", c.params.id);
      m.cancelRule(c.params.id, "规则已删除");
      db.run("DELETE FROM alert_states WHERE rule_id=?", c.params.id);
      db.run(
        "UPDATE alert_outbox SET status='cancelled' WHERE status IN ('queued','retry') AND event_id IN (SELECT id FROM alert_events WHERE rule_id=?)",
        c.params.id,
      );
    });
    c.json({ ok: true });
  });
  r.post("/api/v1/alerts/rules/:id/silence", async (c) => {
    const input = await c.body<any>();
    if (!input || typeof input !== "object" || Array.isArray(input)) c.error(400, "配置必须为对象");
    const rule = capabilities.getRule(c.user, c.params.id);
    const prepared = await capabilities.prepare(c.user, "rule.silence", {
      id: rule.id, revision: input.revision ?? rule.revision, until: input.until ?? "",
    }, c.signal);
    c.json(db.transaction(() => capabilities.commit(c.user, prepared)));
  });
  r.post("/api/v1/alerts/preview", async (c) => {
    const v = normalizeRule(await c.body<any>());
    await guardedAsync(c, () => validateRule(m, v));
    c.json(await m.inspect(v));
  });
  r.get("/api/v1/alerts/instances", async (c) => {
    const ids = await filteredIDs(m, c);
    c.json(
      m
        .list("SELECT body FROM alert_states ORDER BY rule_id")
        .filter((v) => ids.has(v.rule_id)),
    );
  });
  r.get("/api/v1/alerts/events", async (c) => {
    const ids = await filteredIDs(m, c);
    c.json(
      m
        .list(
          "SELECT body FROM alert_events ORDER BY created_at DESC LIMIT 1000",
        )
        .filter((v) => !c.url.search || ids.has(v.rule_id)),
    );
  });
  r.get("/api/v1/alerts/tables", async (c) => {
    const tables = await m.deps.cat.list(c.signal),
      rules = m.rules(),
      allowed = await filteredIDs(m, c, rules),
      out: any[] = [],
      q = c.url.searchParams;
    for (const table of tables) {
      const all = rules.filter((v) => v.source_table_ids?.includes(table.id)),
        visible = all.filter((v) => allowed.has(v.id));
      if (!table.alert_group_id && !all.length) continue;
      if (
        (q.get("table_id") && q.get("table_id") !== table.id) ||
        (q.get("group_id") &&
          q.get("group_id") !== table.alert_group_id &&
          !visible.length) ||
        (q.get("service") && !table.services.includes(q.get("service")!)) ||
        (q.get("enabled") && !visible.length)
      )
        continue;
      let configured = false;
      const warnings: string[] = [];
      for (const rule of all.length
        ? all
        : [{ source_table_ids: [table.id] }]) {
        try {
          const v = await m.route(rule);
          configured ||= !!v.routes.length;
          warnings.push(...v.warnings);
        } catch (e) {
          warnings.push((e as Error).message);
        }
      }
      out.push({
        table,
        rules: visible,
        configured,
        warning: !all.length
          ? table.alert_group_id
            ? "仅绑定组，暂无规则"
            : "未绑定告警组"
          : warnings.join("; "),
      });
    }
    c.json(out);
  });
  r.get("/api/v1/notify/deliveries", async (c) => {
    const q = c.url.searchParams,
      allowed = await filteredIDs(m, c);
    c.json(
      db
        .all<any>(
          "SELECT body,status FROM alert_outbox ORDER BY created_at DESC LIMIT 1000",
        )
        .map((row) => ({ ...parseJSON(row.body), status: row.status }))
        .filter(
          (v) =>
            ((!q.get("service") && !q.get("enabled")) ||
              allowed.has(v.rule_id)) &&
            (!q.get("table_id") || v.table_ids?.includes(q.get("table_id"))) &&
            (!q.get("group_id") || v.group_ids?.includes(q.get("group_id"))) &&
            (!q.get("rule_id") || v.rule_id === q.get("rule_id")) &&
            (!q.get("status") || v.status === q.get("status")),
        ),
    );
  });
  r.post("/api/v1/notify/deliveries/:id/retry", async (c) => {
    const row = db.get<any>(
      "SELECT body,status FROM alert_outbox WHERE id=?",
      c.params.id,
    );
    if (!row) c.error(404, "notification not found");
    if (!["failed", "unknown", "expired"].includes(row.status))
      c.error(409, "only failed/unknown/expired tasks can retry");
    const body = await c.body<any>();
    if (row.status === "unknown" && !body.confirm_possible_duplicate)
      c.error(409, "重试可能重复发送，请明确确认");
    const d = parseJSON(row.body);
    Object.assign(d, {
      status: "queued",
      attempts: 0,
      error: "",
      next_attempt: stamp(m.now()),
      created_at: stamp(m.now()),
    });
    m.updateDelivery(d);
    c.json(d);
  });
  r.get("/api/v1/alerts/annotations", (c) => {
    const q = c.url.searchParams,
      from = q.get("from") ?? "",
      to = q.get("to") ?? "",
      ids = q.getAll("rule_id"),
      panel = q.get("panel_id") ?? "";
    guarded(c, () => validRange({ from, to }));
    if (
      (!ids.length && !panel) ||
      ids.length > 16 ||
      bytes(panel) > 128 ||
      ids.some((v) => !v || bytes(v) > 128)
    )
      c.error(400, "请选择有效时间范围、图表或 1–16 条告警规则");
    const rules = m
        .rules()
        .filter(
          (v) =>
            ids.includes(v.id) ||
            (panel && v.panel_condition?.panel_id === panel),
        ),
      keys = unique([...ids, ...rules.map((v) => v.id)]);
    if (!keys.length) {
      c.json({ events: [], rules, truncated: false });
      return;
    }
    const events = m.list(
      `SELECT body FROM alert_events WHERE created_at>=? AND created_at<=? AND rule_id IN (${keys.map(() => "?").join(",")}) AND json_extract(body,'$.kind') IN ('firing','resolved') ORDER BY created_at LIMIT 501`,
      normalizeStamp(from),
      normalizeStamp(to),
      ...keys,
    );
    c.json({
      events: events.slice(0, 500),
      rules,
      truncated: events.length > 500,
    });
  });
  r.get("/api/v1/alerts/policy-defaults", (c) => c.json(defaultPolicies()));
  r.get("/api/v1/alerts/responders", (c) =>
    c.json(
      db.all<any>("SELECT id,name,active FROM users ORDER BY name").map((v) => {
        const p = m.member(v.id)?.profile ?? {};
        return {
          ...v,
          active: !!v.active,
          has_email: !!p.email,
          has_phone: !!p.phone,
          has_feishu: !!p.feishu_id,
        };
      }),
    ),
  );
  r.get("/api/v1/alerts/incidents", (c) => {
    let where = "1=1";
    const p: any[] = [];
    for (const key of ["state", "group_id"])
      if (c.url.searchParams.get(key)) {
        where += " AND " + key + "=?";
        p.push(c.url.searchParams.get(key));
      }
    if (c.url.searchParams.get("priority")) {
      where += " AND json_extract(body,'$.priority')=?";
      p.push(c.url.searchParams.get("priority"));
    }
    c.json(
      m.list(
        "SELECT body FROM alert_responses WHERE " +
          where +
          " ORDER BY created_at DESC LIMIT 500",
        ...p,
      ),
    );
  });
  r.get("/api/v1/alerts/incidents/:id", (c) => {
    const v = incident(m, c);
    c.json({
      incident: v,
      timeline: m.list(
        "SELECT body FROM alert_response_events WHERE response_id=? ORDER BY at,rowid",
        v.id,
      ),
    });
  });
  r.post("/api/v1/alerts/incidents/:id/ack", async (c) =>
    c.json(
      await guardedAsync(
        c,
        () => m.acknowledge(c.params.id, c.user.id, "web"),
        409,
      ),
    ),
  );
  r.post("/api/v1/alerts/claim", async (c) => {
    const input = await c.body<any>();
    if (typeof input.token !== "string" || input.token.length !== 32)
      c.error(400, "无效的接手链接");
    const row = db.get<any>(
      "SELECT response_id,user_id,method,expires_at FROM alert_claim_tokens WHERE token_hash=?",
      hash(input.token),
    );
    if (!row || parseTime(row.expires_at) <= m.now().getTime())
      c.error(410, "接手链接已过期");
    if (row.user_id && row.user_id !== c.user.id)
      c.error(403, "请使用接收此通知的账号登录");
    c.json(
      await guardedAsync(
        c,
        () => m.acknowledge(row.response_id, c.user.id, row.method),
        409,
      ),
    );
  });
  r.post("/api/v1/alerts/incidents/:id/renew", (c) => {
    const v = incident(m, c);
    if (v.state !== "acknowledged" || v.owner_id !== c.user.id)
      c.error(403, "只有当前接手人可以续期");
    v.handling_until = stamp(
      new Date(
        m.now().getTime() +
          (policy(v.group, v.priority).handling_seconds || 3600) * 1000,
      ),
    );
    db.transaction(() => {
      m.saveResponse(v);
      m.audit(v, "renewed", c.user.id, "web", "确认仍在处理，延长处理期限");
    });
    c.json(v);
  });
  r.post("/api/v1/alerts/incidents/:id/transfer", async (c) => {
    const body = await c.body<any>(),
      v = incident(m, c);
    if (
      ["resolved", "cancelled"].includes(v.state) ||
      !(v.owner_id === c.user.id || c.user.role === "admin")
    )
      c.error(403, "当前接手人或管理员可以转交");
    const g = m.group(v.group_id),
      user = m.member(body.user_id);
    if (!g?.members.includes(body.user_id) || !user)
      c.error(400, "转交人必须为有效组成员");
    resetPaging(v, m);
    v.active_seconds = 0;
    v.group.fallback = [body.user_id];
    v.stage = "fallback";
    db.transaction(() => {
      m.saveResponse(v);
      m.cancelQueue(v.id);
      m.audit(
        v,
        "transfer",
        c.user.id,
        "web",
        "转交给" + user.name + "，等待其接手",
      );
    });
    c.json(v);
  });
  r.post("/api/v1/alerts/incidents/:id/escalate", (c) => {
    const v = incident(m, c);
    if (!canRespond(m, v, c) || ["resolved", "cancelled"].includes(v.state))
      c.error(403, "没有响应权限或事件已恢复");
    resetPaging(v, m);
    v.stage = v.stage === "primary" ? "backup" : "fallback";
    db.transaction(() => {
      m.saveResponse(v);
      m.audit(v, "manual_escalation", c.user.id, "web", "主动通知" + v.stage);
    });
    c.json(v);
  });
  r.post("/api/v1/alerts/incidents/:id/replan", (c) => {
    m.deps.auth.requireAdmin(c);
    const v = incident(m, c),
      g = m.group(v.group_id);
    if (["resolved", "cancelled"].includes(v.state))
      c.error(409, "已结束事件不能重新规划");
    if (!g?.enabled || !g.members?.length) c.error(409, "当前责任组不可用");
    Object.assign(v, {
      group: g,
      group_name: g.name,
      generation: v.generation + 1,
      stage: "primary",
      round: 0,
      stage_round: 0,
      successful_rounds: 0,
      counted_round: 0,
      level_active_seconds: 0,
      since_round_seconds: 0,
      night_period: "",
      night_count: 0,
      night_last_round_at: "",
      night_eligible_at: "",
      exhausted: false,
      deferred_reason: "",
      last_tick: stamp(m.now()),
    });
    db.transaction(() => {
      m.saveResponse(v);
      m.cancelQueue(v.id);
      m.audit(
        v,
        "replanned",
        c.user.id,
        "web",
        "应用当前责任组配置，保留接手人与历史通知",
      );
    });
    c.json(v);
  });
  r.post("/api/v1/alerts/groups/:id/schedule-preview", async (c) => {
    const input = await c.body<any>(),
      g = input.group || m.group(c.params.id);
    if (!g) c.error(404, "告警组不存在");
    guarded(c, () =>
      validatePolicyGroup(
        g,
        (key) => m.member(key),
        (key) => m.channel(key),
      ),
    );
    const from = Number.isFinite(parseTime(input.from))
        ? new Date(input.from)
        : m.now(),
      n = localParts(from, g.timezone),
      out: any[] = [],
      days = Math.min(90, input.days > 0 ? input.days : 14);
    for (let i = 0; i < days; i++) {
      const date = new Date(n.calendar + i * 86400000),
        at = zonedDate(
          date.getUTCFullYear(),
          date.getUTCMonth() + 1,
          date.getUTCDate(),
          n.hour,
          n.minute,
          n.second,
          g.timezone,
        ),
        shift = onCall(g, at);
      out.push({
        at: stamp(at),
        date: localParts(at, g.timezone).date,
        ...shift,
        coverage_gap: !m.activeMembers(shift.primary).length,
      });
    }
    c.json(out);
  });
  r.get("/api/v1/alerts/silences", (c) => c.json(capabilities.listSilences(c.user, Object.fromEntries(c.url.searchParams))));
  r.get("/api/v1/alerts/silences/:id", (c) => c.json(capabilities.getSilence(c.user, c.params.id)));
  r.post("/api/v1/alerts/silences", async (c) => {
    const input = await c.body<any>();
    // Existing forms send empty host fields; identity and object IDs remain server-owned.
    if (input && typeof input === "object" && !Array.isArray(input)) {
      delete input.id;
      delete input.created_by;
      delete input.revision;
      delete input.version;
    }
    const prepared = await capabilities.prepare(c.user, "silence.create", { silence: input }, c.signal);
    c.json(db.transaction(() => capabilities.commit(c.user, prepared)));
  });
  r.put("/api/v1/alerts/silences/:id", async (c) => {
    const input = await c.body<any>();
    if (!input || typeof input !== "object" || Array.isArray(input)) c.error(400, "配置必须为对象");
    const current = capabilities.getSilence(c.user, c.params.id);
    const version = input.version ?? (Number.isSafeInteger(input.revision) && input.revision === current.revision ? current.version : "");
    const patch = input.patch ?? Object.fromEntries(Object.entries(input).filter(([key]) => !["id", "created_by", "revision", "version", "ended_at"].includes(key)));
    const prepared = await capabilities.prepare(c.user, "silence.update", { id: current.id, version, patch }, c.signal);
    c.json(db.transaction(() => capabilities.commit(c.user, prepared)));
  });
  r.delete("/api/v1/alerts/silences/:id", async (c) => {
    const current = capabilities.getSilence(c.user, c.params.id);
    const prepared = await capabilities.prepare(c.user, "silence.end", {
      id: current.id, version: c.url.searchParams.get("version") || current.version,
    }, c.signal);
    db.transaction(() => capabilities.commit(c.user, prepared));
    c.json({ ok: true });
  });
  r.get("/api/v1/alerts/response-statistics", (c) => responseStatistics(m, c));
  r.get("/api/v1/traces/:trace_id", (c) => traceDetail(m, c));
  registerDirectory(m);
}
export function responseStatistics(m: Alerts, c: Context): void {
  const q = c.url.searchParams,
    from = Number.isFinite(parseTime(q.get("from")))
      ? new Date(q.get("from")!)
      : new Date(m.now().getTime() - 30 * 86400000),
    to = Number.isFinite(parseTime(q.get("to")))
      ? new Date(q.get("to")!)
      : new Date(m.now().getTime() + 1000);
  if (to <= from) c.error(400, "统计结束时间必须晚于开始时间");
  let where = "a.notified_at>=? AND a.notified_at<?";
  const p: any[] = [stamp(from), stamp(to)];
  if (q.get("group_id")) {
    where += " AND i.group_id=?";
    p.push(q.get("group_id"));
  }
  if (q.get("priority")) {
    where += " AND a.priority=?";
    p.push(q.get("priority"));
  }
  const rows = m.deps.db.all<any>(
      `SELECT a.response_id,a.user_id,a.user_name,a.stage,a.priority,a.notified_at,a.ack_at,a.ack_method,a.outcome,i.body FROM alert_assignments a JOIN alert_responses i ON i.id=a.response_id WHERE ${where} ORDER BY a.notified_at DESC LIMIT 20000`,
      ...p,
    ),
    users = new Map<string, any>(),
    records: any[] = [];
  const ensure = (uid: string, name: string) => {
    if (!users.has(uid))
      users.set(uid, {
        user_id: uid,
        user_name: name,
        notified: 0,
        acknowledged: 0,
        peer_claimed: 0,
        recovered: 0,
        cancelled: 0,
        pending: 0,
        ack_rate: 0,
        mean_ack_seconds: 0,
        median_ack_seconds: 0,
        p95_ack_seconds: 0,
        methods: {},
        priorities: {},
        durations: [],
      });
    return users.get(uid);
  };
  for (const row of rows) {
    const incident = parseJSON(row.body),
      v = ensure(row.user_id, row.user_name);
    v.notified++;
    v.priorities[row.priority] = (v.priorities[row.priority] || 0) + 1;
    let seconds = 0;
    if (row.ack_at) {
      v.acknowledged++;
      v.methods[row.ack_method] = (v.methods[row.ack_method] || 0) + 1;
      seconds = Math.max(
        0,
        (parseTime(row.ack_at) - parseTime(row.notified_at)) / 1000,
      );
      v.durations.push(seconds);
      v.mean_ack_seconds += seconds;
    } else
      v[
        ["peer_claimed", "recovered", "cancelled"].includes(row.outcome)
          ? row.outcome
          : "pending"
      ]++;
    const { body, ...record } = row;
    records.push({
      ...record,
      group_id: incident.group_id,
      group_name: incident.group_name,
      rule_id: incident.rule_id,
      rule_name: incident.event.rule_name,
      source_priority: incident.original_priority,
      ack_seconds: seconds,
    });
  }
  const zero = q.get("group_id")
    ? (m.group(q.get("group_id")!)?.members ?? [])
        .map((key: string) => m.member(key))
        .filter(Boolean)
    : m.deps.db.all<any>("SELECT id,name FROM users WHERE active=1");
  for (const user of zero) ensure(user.id, user.name);
  const out = [...users.values()]
    .map((v) => {
      if (v.notified) v.ack_rate = (v.acknowledged * 100) / v.notified;
      if (v.acknowledged) {
        v.mean_ack_seconds /= v.acknowledged;
        v.durations.sort((a: number, b: number) => a - b);
        const n = v.durations.length,
          mid = Math.floor(n / 2);
        v.median_ack_seconds =
          n % 2
            ? v.durations[mid]
            : (v.durations[mid - 1] + v.durations[mid]) / 2;
        v.p95_ack_seconds = v.durations[Math.max(0, Math.ceil(n * 0.95) - 1)];
      }
      delete v.durations;
      return v;
    })
    .sort((a, b) => a.user_name.localeCompare(b.user_name));
  c.json({
    from: stamp(from),
    to: stamp(to),
    users: out,
    records,
    truncated: records.length === 20000,
    definition:
      "接手率=本人接手告警数/实际通知本人的不同组告警数；多渠道与重试去重。接手时长从首次通知受理到接手。其他人接手与自动恢复单独列示。",
  });
}
