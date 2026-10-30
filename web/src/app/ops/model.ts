export type ResourceKind =
  | "credential"
  | "dns_zone"
  | "acme_account"
  | "certificate"
  | "certificate_target"
  | "application"
  | "cluster"
  | "website";
export type Spec = Record<string, any>;
export type Resource = {
  id: string;
  kind: ResourceKind;
  name: string;
  revision: number;
  spec: Spec;
  status: Spec;
  created_at: string;
  updated_at: string;
};
export type Agent = {
  id: string;
  hostname?: string;
  host_id?: string;
  last_seen?: string;
  capabilities?: unknown;
};
export type Run = {
  id: string;
  resource_id: string;
  resource_revision: number;
  agent_id: string;
  action: string;
  state: string;
  result: Spec;
  created_at: string;
  updated_at: string;
  job_id?: string;
};
export type Machine = { id: string; name: string; address?: string; agent_id?: string; agent_status?: string; cluster_id?: string };
export type CatalogTemplate = { id: string; name: string; description?: string; category?: string; version: string; versions?: string[]; managed_recommended: boolean; managed_reason?: string; parameters?: {key: string; label: string; type: string; required?: boolean; default?: unknown}[]; spec?: Spec };
export type Overview = {
  machines?: Machine[];
  resources: Resource[];
  agents: Agent[];
  runs: Run[];
  capabilities?: Spec;
};
export const ACTIONS: Record<ResourceKind, string[]> = {
  credential: ["test"],
  dns_zone: ["sync"],
  acme_account: ["register"],
  certificate: ["issue", "renew", "inspect"],
  certificate_target: ["sync", "inspect", "retry"],
  application: ["deploy", "inspect", "stop", "remove", "logs", "endpoints", "reconcile"],
  cluster: ["inspect"],
  website: ["deploy", "inspect", "disable"],
};
export const KIND_NAMES: Record<ResourceKind, [string, string]> = {
  website: ["网站", "Websites"],
  dns_zone: ["托管域名", "DNS zones"],
  certificate: ["证书", "Certificates"],
  certificate_target: ["证书目标", "Certificate targets"],
  application: ["应用", "Applications"],

  credential: ["云平台凭据", "Cloud credentials"],
  acme_account: ["ACME 账号", "ACME accounts"],
  cluster: ["集群", "Clusters"],
};
export const ACTION_NAMES: Record<string, [string, string]> = {
  test: ["测试凭据", "Test credentials"],
  sync: ["同步", "Synchronize"],
  register: ["注册账号", "Register account"],
  issue: ["签发证书", "Issue certificate"],
  renew: ["续期证书", "Renew certificate"],
  inspect: ["检查状态", "Inspect"],
  retry: ["重试分发", "Retry delivery"],
  deploy: ["部署", "Deploy"],
  stop: ["停止", "Stop"],
  remove: ["移除容器", "Remove containers"],
  logs: ["读取日志", "Read logs"],
  reconcile: ["调度副本", "Reconcile replicas"],
  endpoints: ["检查服务发现", "Inspect discovery"],
  disable: ["停用网站", "Disable website"],
};
export function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
export function time(value?: string) {
  return value ? new Date(value).toLocaleString() : "—";
}
export function resourceState(resource: Resource): string {
  const s = resource.status ?? {};
  const current = (Array.isArray(s.instances) ? s.instances : []).filter((instance: Spec) => !instance.retired);
  if (resource.kind === "application" && Array.isArray(resource.spec.deployments)) {
    const published = Object.values(s.deployments ?? {}).filter((deployment: any) => deployment.enabled && Number(deployment.desired_revision) > 0) as Spec[];
    if (published.length) {
      if (current.some((instance: Spec) => instance.state === "unknown")) return "unknown";
      const allApplied = published.every((deployment) => Number(deployment.applied_revision) === Number(deployment.desired_revision));
      if (allApplied && current.length && current.every((instance: Spec) => instance.healthy && instance.state === "running")) return "running";
      if (allApplied && !current.length && resource.spec.deployment_mode === "managed" && resource.spec.deployments.every((deployment: Spec) => deployment.replicas === 0)) return "stopped";
      if (published.some((deployment) => deployment.last_error) || current.some((instance: Spec) => ["failed", "error"].includes(instance.state))) return "failed";
      return "pending";
    }
  }
  if (s.state) return String(s.state);
  if (s.phase) return String(s.phase);
  if (s.last_error) return "failed";
  const instances = current;
  if (instances.length && instances.every((i: Spec) => i.state === "removed"))
    return "removed";
  if (instances.length && instances.every((i: Spec) => ["stopped", "removed"].includes(i.state)))
    return "stopped";
  if (instances.some((i: Spec) => i.state === "unknown")) return "unknown";
  if (instances.some((i: Spec) => ["failed", "error"].includes(i.state)))
    return "failed";
  if (instances.length)
    return instances.every((i: Spec) => i.healthy || i.state === "running")
      ? "running"
      : "pending";
  if (s.fingerprint_sha256 || s.certificate_version) return "issued";
  if (s.last_synced_at || s.registered || s.records) return "observed";
  return "configured";
}
export const mapRows = (value?: Record<string, unknown>) =>
  Object.entries(value ?? {}).map(([key, value]) => ({
    key,
    value: String(value),
  }));
export function rowsMap(rows?: { key?: string; value?: string }[]) {
  return Object.fromEntries(
    (rows ?? [])
      .filter((row) => row.key?.trim())
      .map((row) => [row.key!.trim(), row.value ?? ""]),
  );
}
const headerText = (value?: Spec) =>
  Object.entries(value ?? {})
    .map(([key, value]) => key + ": " + value)
    .join("\n");
function parseHeaders(text?: string): Spec {
  const result: Spec = {};
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;
    const colon = line.indexOf(":");
    if (colon < 1)
      throw Error("Header must use Name: Value / 请求头格式应为 名称: 值");
    const key = line.slice(0, colon).trim();
    if (Object.keys(result).some((k) => k.toLowerCase() === key.toLowerCase()))
      throw Error("Duplicate header / 请求头名称重复");
    result[key] = line.slice(colon + 1).trim();
  }
  return result;
}
export function editorValues(kind: ResourceKind, resource?: Resource) {
  const defaults: Partial<Record<ResourceKind, Spec>> = {
    credential: { provider: "aliyun" },
    dns_zone: {},
    acme_account: { directory_url: "letsencrypt-staging", terms_agreed: false },
    certificate: {
      source: "acme",
      auto_renew: true,
      renew_before_days: 30,
      validity_days: 90,
      domains: [],
    },
    certificate_target: {
      type: "directory",
      enabled: false,
      certificate_file: "fullchain.pem",
      private_key_file: "privkey.pem",
      mode: "0644",
      private_key_mode: "0600",
      product: "cdn",
      provider: "aliyun",
      interpreter: "/bin/sh",
      timeout_ms: 60000,
    },
    application: {
      mode: "container",
      network_mode: "bridge",
      cpu: 1,
      memory_mb: 512,
      source: { type: "custom" },
      deployment_mode: "manual",
      role: "generic",
      deployments: [{machine_ids: [], replicas: 1, cpu: 1, memory_mb: 512}],
      stateful: false,
      health: { type: "tcp", interval_seconds: 10 },
      ports: [],
      mounts: [],
    },
    cluster: { machine_ids: [], port_start: 20000, port_end: 29999, nodes: [] },
    website: {
      routing_mode:"manual",
      dns_record_mode:resource?"address":"cname",
      cluster_policies:[],
      cluster_ids: [],
      bindings: [{ domains: [], https: false, dns_enabled: false, locations: [] }],
      mode: "proxy",
      https: false,
      dns_enabled: false,
      nginx: {
        body_size_mb: 20,
        keepalive_seconds: 75,
        gzip: false,
        gzip_level: 5,
        access_log: true,
        error_log_level: "warn",
        http2: false,
        redirect_https: false,
        tls_protocols: ["TLSv1.2", "TLSv1.3"],
        index: ["index.html"],
        spa_fallback: false,
        autoindex: false,
        expires_seconds: 0,
      },
    },
  };
  const spec = { ...defaults[kind], ...resource?.spec };
  if (kind === "application" && !spec.deployments?.length && spec.cluster_id) spec.deployments = [{cluster_id:spec.cluster_id,machine_ids:spec.machine_ids??[],replicas:spec.replicas??1,cpu:spec.cpu??1,memory_mb:spec.memory_mb??512}];
  if (kind === "website" && !spec.cluster_ids?.length && spec.cluster_id) spec.cluster_ids = [spec.cluster_id];
  spec.env_rows = mapRows(spec.environment ?? spec.env);
  spec.file_rows = mapRows(spec.static_files);
  spec.public_address_rows = mapRows(spec.public_addresses);
  spec.command_rows = (spec.command ?? []).map((value: string) => ({ value }));
  spec.upstream_rows = (spec.upstreams ?? []).map((value: string) => ({
    value,
  }));
  if (kind === "website") {
    spec.nginx = { ...spec.nginx, response_headers_text: headerText(spec.nginx?.response_headers) };
    spec.bindings = (spec.bindings ?? []).map((binding: Spec) => ({ ...binding, locations: (binding.locations ?? []).map((r: Spec) => ({ ...r,
      upstreams: (r.upstreams ?? []).map((u: any) => typeof u === "string" ? { url: u, weight: 1 } : u),
      request_headers_text: headerText(r.request_headers), response_headers_text: headerText(r.response_headers),
    })) }));
  }
  spec.mounts = (spec.mounts ?? []).map((mount: Spec) => ({
    ...mount,
    file_rows: mapRows(mount.files),
  }));
  if (typeof spec.compose === "object")
    spec.compose = JSON.stringify(spec.compose, null, 2);
  return { name: resource?.name ?? "", spec };
}
export function serializeSpec(kind: ResourceKind, values: Spec): Spec {
  const spec = { ...values };
  if (kind === "application") {
    spec.environment = rowsMap(spec.env_rows);
    spec.command = (spec.command_rows ?? [])
      .map((r: Spec) => r.value)
      .filter(Boolean);
    spec.mounts = (spec.mounts ?? []).map((m: Spec) => {
      const mount: Spec = { ...m, files: rowsMap(m.file_rows) };
      delete mount.file_rows;
      return mount;
    });

    if (spec.network_mode !== "bridge") delete spec.networks;
    if (spec.mode === "compose") {
      delete spec.image;
      delete spec.command;
      delete spec.environment;
      delete spec.networks;
      delete spec.network_mode;
      try {
        spec.compose = JSON.parse(spec.compose);
      } catch {
        /* New Compose YAML is parsed and validated by the controller. */
      }
    } else delete spec.compose;
  }
  if (kind === "website") {
    spec.static_files = rowsMap(spec.file_rows);
    spec.nginx = { ...spec.nginx, response_headers: parseHeaders(spec.nginx?.response_headers_text) };
    delete spec.nginx.response_headers_text;
    spec.bindings = (spec.bindings ?? []).map((binding: Spec) => {
      const result: Spec = { ...binding, locations: (binding.locations ?? []).map((r: Spec) => {
        const route: Spec = { ...r, request_headers: parseHeaders(r.request_headers_text), response_headers: parseHeaders(r.response_headers_text) };
        delete route.request_headers_text; delete route.response_headers_text;
        route.cluster_targets = (route.action === "return" ? [] : route.cluster_targets ?? []).map((target: Spec) => {
          const value = { ...target };
          if (value.target === "application") delete value.upstreams;
          else { delete value.application_id; delete value.port_name; }
          return value;
        });
        for (const key of ["application_id", "port_name", "upstreams", "target", "service_id"]) delete route[key];
        return route;
      }) };
      if (!result.https) delete result.certificate_id;
      if (!result.dns_enabled) delete result.dns_zone_id;
      return result;
    });
    if (spec.mode !== "static") delete spec.static_files;
    for (const key of ["domains", "https", "dns_enabled", "certificate_id", "dns_zone_id", "gateway_group_id", "service_id", "locations", "upstreams", "cluster_id", "openresty_application_id"]) delete spec[key];
  }
  if (kind === "application") {
    spec.deployments = (spec.deployments ?? []).map((deployment: Spec) => {
      const result = { ...deployment };
      if (spec.deployment_mode === "managed") delete result.machine_ids;
      else delete result.replicas;
      return result;
    });
    for (const key of ["cluster_id", "machine_ids", "replicas", "cpu", "memory_mb", "stateful_acknowledged"]) delete spec[key];
    if (!spec.service_name) delete spec.service_name;
    if (!spec.health?.port_name) delete spec.health;
  }
  if (kind === "certificate_target") {
    spec.env = rowsMap(spec.env_rows);
    const fields: Record<string, string[]> = {
      directory: [
        "agent_id",
        "path",
        "certificate_file",
        "private_key_file",
        "mode",
        "private_key_mode",
        "owner",
        "group",
      ],
      cloud: ["provider", "credential_id", "product", "domains"],
      hook: [
        "agent_id",
        "script",
        "interpreter",
        "timeout_ms",
        "env",
        "clear_env",
      ],
    };
    for (const field of Object.values(fields).flat())
      if (!fields[spec.type]?.includes(field)) delete spec[field];
  }
  if (kind === "certificate") {
    if (spec.source !== "acme") {
      delete spec.acme_account_id;
      delete spec.dns_zone_ids;
    }
    if (spec.source === "uploaded") spec.auto_renew = false;
  }
  for (const key of Object.keys(spec))
    if (
      key.endsWith("_rows") ||
      key.startsWith("has_") ||
      spec[key] === undefined ||
      spec[key] === ""
    )
      delete spec[key];
  return spec;
}
