import { metricWindows, registerMetricWindows } from './metric-windows.js';
import {
  isLosslessNumber,
  LosslessNumber,
  parse as parseLossless,
} from "lossless-json";
import { fail } from "../shared/http.js";
import { hash } from "../shared/crypto.js";
import { parseJSON, stringifyJSON } from "../shared/json.js";
import type { Dependencies, Context } from "../shared/types.js";
import type { Catalog } from "./catalog.js";
import { goJSON } from "../shared/otlp.js";
import { systemTable } from "./auth.js";
import type { AgentCredentialStore } from "./agent-credentials.js";
export const defaultSampling = () => ({
  key: "event_id",
  rules: [{ name: "all", rate: 1, conditions: [] }],
  exclude: [],
});
const only = (v: any, keys: string[]) => {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).some((k) => !keys.includes(k))
  )
    fail(400, "unknown reporting rule field");
};
const fieldValid = (v: any) =>
  typeof v === "string" &&
  Buffer.byteLength(v) <= 136 &&
  !v.includes("\0") &&
  (/^(event_id|service|severity|trace_id|instance_id|sdk\.language)$/.test(v) ||
    /^(attr|resource):.+$/.test(v));
function conditions(values: any, sdk: boolean): any[] {
  if (!Array.isArray(values) || values.length > 8)
    fail(400, "conditions must be an array of at most 8 conditions");
  return values.map((c) => {
    only(c, ["field", "operator", "values"]);
    if (!fieldValid(c.field)) fail(400, "invalid rule field");
    if (
      sdk &&
      !["service", "instance_id", "sdk.language"].includes(c.field) &&
      !c.field.startsWith("resource:")
    )
      fail(400, "invalid SDK selector");
    if (!Array.isArray(c.values ?? [])) fail(400, "values must be an array");
    const inputs = c.values ?? [];
    if (c.operator === "exists") {
      if (inputs.length) fail(400, "exists requires no values");
    } else if (c.operator === "in") {
      if (
        !inputs.length ||
        inputs.length > 256 ||
        inputs.some(
          (v: any) =>
            !["string", "boolean"].includes(typeof v) &&
            !(typeof v === "number" && Number.isFinite(v)) &&
            !(isLosslessNumber(v) && Number.isFinite(Number(v.value))),
        )
      )
        fail(400, "in requires 1 to 256 scalar values");
    } else fail(400, "operator must be in or exists");
    const out: any = { field: c.field, operator: c.operator };
    if (inputs.length) out.values = inputs;
    return out;
  });
}
export function exclusions(rules: any, sdk = false): any[] {
  if (!Array.isArray(rules) || rules.length > 32)
    fail(400, "at most 32 exclusion rules");
  const out = rules.map((r) => {
    only(r, ["name", "conditions"]);
    if (
      (r.name !== undefined && r.name !== null && typeof r.name !== "string") ||
      Buffer.byteLength(r.name ?? "") > 64 ||
      !Array.isArray(r.conditions) ||
      !r.conditions.length
    )
      fail(400, "exclusions require a condition");
    return { name: r.name ?? "", conditions: conditions(r.conditions, sdk) };
  });
  if (Buffer.byteLength(goJSON(out)) > 64 << 10)
    fail(400, "rules exceed 64 KiB");
  return out;
}
export function sampling(v: any): any {
  only(v, ["key", "rules", "exclude"]);
  const key = v.key ?? "event_id";
  if (
    !fieldValid(key || "event_id") ||
    !Array.isArray(v.rules) ||
    v.rules.length > 32
  )
    fail(400, "invalid sampling key or rules");
  const rules = v.rules.map((r: any) => {
    only(r, ["name", "rate", "conditions"]);
    const rate = Number(r.rate);
    if (
      (r.name !== undefined && r.name !== null && typeof r.name !== "string") ||
      Buffer.byteLength(r.name ?? "") > 64 ||
      r.rate === undefined ||
      r.rate === null ||
      (typeof r.rate !== "number" && !isLosslessNumber(r.rate)) ||
      !Number.isFinite(rate) ||
      rate < 0 ||
      rate > 1 ||
      (rate > 0 && rate < 0.000001)
    )
      fail(400, "rule rate must be zero or between 0.000001 and 1");
    return {
      name: r.name ?? "",
      rate,
      conditions: conditions(r.conditions, false),
    };
  });
  const out = {
    key: key || "event_id",
    rules,
    exclude:
      v.exclude === undefined || v.exclude === null
        ? []
        : exclusions(v.exclude),
  };
  if (Buffer.byteLength(goJSON(out)) > 64 << 10)
    fail(400, "policy exceeds 64 KiB");
  return out;
}
/** Preserve json.Number lexical values in old stored selectors for revision hashes. */
function exactConfigJSON(raw: string): any {
  return parseLossless(raw, undefined, (value) => new LosslessNumber(value));
}
export function sdkConfiguration(
  policies: Record<string, any>,
  disableRules: any,
): any {
  const ordered: Record<string, any> = {};
  for (const table of Object.keys(policies).sort())
    ordered[table] = sampling(policies[table]);
  const config = {
    revision: "",
    log_sampling: ordered,
    disable_rules:
      disableRules === null ? null : exclusions(disableRules, true),
  };
  config.revision = hash(goJSON(config));
  return config;
}
export function reportingSettings(d: Dependencies) {
  let book: any;
  const row = d.db.get<any>(
    "SELECT value FROM instance_settings WHERE name='reporting_endpoints'",
  );
  if (row) book = JSON.parse(row.value);
  else {
    const old = d.db.get<any>(
      "SELECT value FROM instance_settings WHERE name='reporting_endpoint'",
    )?.value;
    book = {
      endpoints: old ? [{ id: "default", name: "默认地址", url: old }] : [],
      default_endpoint_id: old ? "default" : "",
    };
  }
  book.endpoints ??= [];
  const defaultEndpoint = d.externalURL.trim().replace(/\/+$/, ""),
    endpoint =
      book.endpoints.find((a: any) => a.id === book.default_endpoint_id)?.url ??
      "";
  return {
    endpoint,
    default_endpoint: defaultEndpoint,
    effective_endpoint: endpoint || defaultEndpoint,
    endpoints: endpoint
      ? book.endpoints
      : [{ id: "deployment", name: "部署地址", url: defaultEndpoint }],
    default_endpoint_id: endpoint ? book.default_endpoint_id : "deployment",
  };
}
function validateAddresses(book: any) {
  if (!Array.isArray(book.endpoints) || book.endpoints.length > 20)
    fail(400, "最多配置 20 个上报地址");
  const ids = new Set(),
    urls = new Set();
  for (const a of book.endpoints) {
    if (
      !a ||
      typeof a.id !== "string" ||
      typeof a.name !== "string" ||
      typeof a.url !== "string"
    )
      fail(400, "上报地址 ID、名称和 URL 必须是文本");
    a.name = a.name.trim();
    a.url = a.url.trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(a.id ?? "") || ids.has(a.id))
      fail(400, "上报地址 ID 无效或重复");
    if (!a.name || [...a.name].length > 64 || /\p{Cc}/u.test(a.name))
      fail(400, "地址名称需要 1–64 个字符");
    try {
      const u = new URL(a.url);
      if (
        Buffer.byteLength(a.url) > 2048 ||
        !["http:", "https:"].includes(u.protocol) ||
        !u.hostname ||
        u.username ||
        u.password ||
        u.search ||
        /[?#\\\r\n\t ]/.test(a.url)
      )
        throw Error();
    } catch {
      fail(
        400,
        "请输入完整的 HTTP(S) 地址，不包含用户名、密码、查询参数或片段",
      );
    }
    a.url = a.url.replace(/\/+$/, "");
    if (urls.has(a.url)) fail(400, "请勿重复配置相同的上报地址");
    ids.add(a.id);
    urls.add(a.url);
  }
  if (!book.endpoints.length) book.default_endpoint_id = "";
  else if (!ids.has(book.default_endpoint_id))
    fail(400, "请选择列表中的默认上报地址");
}
export function registerSettings(
  d: Dependencies,
  agentCredentials?: AgentCredentialStore,
) {
  registerMetricWindows(d);
  const { router: r, db, auth } = d,
    cat = d.cat as Catalog;
  db.exec(
    "CREATE TABLE IF NOT EXISTS instance_settings(name TEXT PRIMARY KEY,value TEXT NOT NULL)",
  );
  r.get("/api/v1/settings/instance", (c) =>
    c.json({ external_url: d.externalURL, version: "0.1.0" }),
  );
  r.get("/api/v1/settings/reporting", (c) => c.json(reportingSettings(d)));
  r.put("/api/v1/settings/reporting", async (c) => {
    auth.requireAdmin(c);
    const v = await c.body();
    if (v.endpoint == null && v.endpoints == null)
      fail(400, "请填写上报地址列表");
    if (v.endpoint != null && typeof v.endpoint !== "string")
      fail(400, "上报地址必须是文本");
    const endpoint = (v.endpoint ?? "").trim();
    const book =
      v.endpoints != null
        ? { endpoints: v.endpoints, default_endpoint_id: v.default_endpoint_id }
        : {
            endpoints: endpoint
              ? [{ id: "default", name: "默认地址", url: endpoint }]
              : [],
            default_endpoint_id: endpoint ? "default" : "",
          };
    validateAddresses(book);
    db.transaction(() => {
      db.run(
        "INSERT INTO instance_settings(name,value) VALUES('reporting_endpoints',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
        JSON.stringify(book),
      );
      db.run(
        "INSERT INTO instance_settings(name,value) VALUES('reporting_endpoint',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
        book.endpoints.find((a: any) => a.id === book.default_endpoint_id)
          ?.url ?? "",
      );
    });
    c.json(reportingSettings(d));
  });
  r.get("/api/v1/settings/retention", (c) =>
    c.json({ default_days: cat.defaultRetention() }),
  );
  const retention = async (c: Context, uid: string | null, value: any) => {
    auth.requireAdmin(c);
    if (
      value === undefined ||
      (uid === null && value === null) ||
      (value !== null &&
        (!Number.isInteger(value) || value < 0 || value > 36500))
    )
      fail(400, "保留时长必须为 0 到 36500 的整数天数，0 表示永久保留");
    if (uid && !db.get("SELECT id FROM catalog WHERE id=?", uid))
      fail(404, "table not found");
    await cat.setRetention(uid, value, c.signal);
    c.json(uid ? { retention_days: value } : { default_days: value });
  };
  r.put("/api/v1/settings/retention", async (c) =>
    retention(c, null, (await c.body()).default_days),
  );
  r.put("/api/v1/catalog/tables/:id/retention", async (c) =>
    retention(c, c.params.id, (await c.body()).retention_days),
  );
  const policies = () =>
    Object.fromEntries(
      db
        .all<any>(
          "SELECT logical_name,policy_json FROM log_sampling ORDER BY logical_name",
        )
        .map((row) => [row.logical_name, exactConfigJSON(row.policy_json)]),
    );
  const disable = () =>
    exactConfigJSON(
      db.get<any>("SELECT disable_rules FROM sdk_reporting WHERE id=1")!
        .disable_rules,
    );
  r.get(
    "/v1/sdk-config",
    (c) => {
      const agentID = String(c.req.headers["x-lightmoni-agent-id"] ?? "");
      // Re-enrolled Agents use the control audience to pull the same validated
      // sampling configuration that legacy ingest keys could read. Keep the
      // old key path for nodes that have not migrated yet.
      const key =
        agentID && (agentCredentials?.registered?.(agentID) ?? agentCredentials?.has(agentID, "control"))
          ? (() => {
              const credential = agentCredentials.authenticate(
                c.req,
                agentID,
                "control",
              );
              return {
                id: credential.credential_id,
                name: "agent:" + agentID,
                allowed_tables: [] as string[],
                allow_all_tables: true,
              };
            })()
          : auth.validateKey(c, undefined, true);
      try {
        const all = policies();
        for (const table of Object.keys(all))
          if (!key.allow_all_tables && !key.allowed_tables.includes(table))
            delete all[table];
        const config: any = sdkConfiguration(all, disable());
        if (c.url.searchParams.get('metric_windows') === '1') {
          config.metric_windows = metricWindows(db, table => key.allow_all_tables || key.allowed_tables.includes(table));
          config.revision = hash(goJSON(config));
        }
        c.res.setHeader("cache-control", "no-store");
        c.json(config);
      } catch {
        fail(503, "SDK configuration unavailable");
      }
    },
    { public: true },
  );
  r.get("/api/v1/settings/sdk-reporting", (c) =>
    c.json({ disable_rules: disable() }),
  );
  r.put("/api/v1/settings/sdk-reporting", async (c) => {
    auth.requireAdmin(c);
    const v = await c.body();
    only(v, ["disable_rules"]);
    const rules = exclusions(v.disable_rules, true);
    db.run(
      "UPDATE sdk_reporting SET disable_rules=? WHERE id=1",
      goJSON(rules),
    );
    c.json({ disable_rules: rules });
  });
  const samplingTable = (uid: string) => {
    const t = db.get<any>(
      "SELECT logical_name,kind FROM catalog WHERE id=?",
      uid,
    );
    if (!t) fail(404, "table not found");
    if (t.kind !== "log" || systemTable(t.logical_name))
      fail(400, "仅业务日志表支持采样");
    return t.logical_name;
  };
  r.get("/api/v1/catalog/tables/:id/log-sampling", (c) => {
    const table = samplingTable(c.params.id),
      raw = db.get<any>(
        "SELECT policy_json FROM log_sampling WHERE logical_name=?",
        table,
      )?.policy_json;
    c.json(raw ? sampling(exactConfigJSON(raw)) : defaultSampling());
  });
  r.put("/api/v1/catalog/tables/:id/log-sampling", async (c) => {
    auth.requireAdmin(c);
    const policy = sampling(await c.body()),
      table = samplingTable(c.params.id),
      all = { ...policies(), [table]: policy };
    if (Buffer.byteLength(goJSON(all)) > 900 << 10)
      fail(400, "所有日志上报配置合计最多 900 KiB");
    db.run(
      "INSERT INTO log_sampling(logical_name,policy_json) VALUES(?,?) ON CONFLICT(logical_name) DO UPDATE SET policy_json=excluded.policy_json,revision=revision+1",
      table,
      goJSON(policy),
    );
    c.json(policy);
  });
}
