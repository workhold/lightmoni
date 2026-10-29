export type ResourceKind =
  | "credential"
  | "dns_zone"
  | "acme_account"
  | "certificate"
  | "certificate_target"
  | "application"
  | "service"
  | "node_pool"
  | "gateway_group"
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
export type Overview = {
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
  application: ["deploy", "inspect", "stop", "remove", "logs"],
  service: ["deploy", "reconcile", "inspect", "stop", "endpoints"],
  node_pool: ["inspect"],
  gateway_group: ["deploy", "inspect", "stop"],
  website: ["deploy", "inspect", "disable"],
};
export const KIND_NAMES: Record<ResourceKind, [string, string]> = {
  website: ["网站", "Websites"],
  dns_zone: ["托管域名", "DNS zones"],
  certificate: ["证书", "Certificates"],
  certificate_target: ["证书目标", "Certificate targets"],
  application: ["应用", "Applications"],
  service: ["托管服务", "Hosted services"],
  credential: ["云平台凭据", "Cloud credentials"],
  acme_account: ["ACME 账号", "ACME accounts"],
  node_pool: ["机器池", "Node pools"],
  gateway_group: ["网关组", "Gateway groups"],
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
  if (s.state) return String(s.state);
  if (s.phase) return String(s.phase);
  if (s.last_error) return "failed";
  const instances = Array.isArray(s.instances) ? s.instances : [];
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
      agent_ids: [],
      ports: [],
      mounts: [],
    },
    service: {
      replicas: 1,
      container_port: 8080,
      cpu: 1,
      memory_mb: 512,
      health: { type: "tcp", interval_seconds: 10 },
      stateful: false,
    },
    node_pool: { agent_ids: [], port_start: 20000, port_end: 29999, nodes: [] },
    gateway_group: {
      agent_ids: [],
      image: "openresty/openresty:1.27.1.2-0-alpine",
      http_port: 80,
      https_port: 443,
    },
    website: { domains: [], mode: "proxy", https: false, dns_enabled: false },
  };
  const spec = { ...defaults[kind], ...resource?.spec };
  spec.env_rows = mapRows(spec.environment ?? spec.env);
  spec.file_rows = mapRows(spec.static_files);
  spec.public_address_rows = mapRows(spec.public_addresses);
  spec.command_rows = (spec.command ?? []).map((value: string) => ({ value }));
  spec.upstream_rows = (spec.upstreams ?? []).map((value: string) => ({
    value,
  }));
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
    if (spec.network_mode === "host") delete spec.ports;
    if (spec.network_mode !== "bridge") delete spec.networks;
    if (spec.mode === "compose") {
      delete spec.image;
      delete spec.command;
      delete spec.environment;
      delete spec.ports;
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
    spec.upstreams = (spec.upstream_rows ?? [])
      .map((r: Spec) => r.value?.trim())
      .filter(Boolean);
    if (spec.mode !== "static") delete spec.static_files;
    if (spec.mode !== "proxy") delete spec.upstreams;
    if (spec.mode !== "service") delete spec.service_id;
    if (!spec.https) delete spec.certificate_id;
    if (!spec.dns_enabled) delete spec.dns_zone_id;
  }
  if (kind === "gateway_group")
    spec.public_addresses = rowsMap(spec.public_address_rows);
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
