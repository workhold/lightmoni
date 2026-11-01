import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { fail } from "../../shared/http.js";
export type Input = Record<string, any>;
export interface CatalogParameter {
  key: string;
  label: string;
  label_en?: string;
  type: "string" | "password" | "secret" | "number" | "select";
  required?: boolean;
  default?: string | number;
  example?: string | number;
  description?: string;
  description_en?: string;
  min?: number;
  max?: number;
  pattern?: string;
  format?: "url" | "host" | "ip";
  options?: { value: string; label: string; label_en?: string }[];
}
export interface CatalogTemplate {
  id: string;
  name: string;
  description: string;
  description_en?: string;
  category: string;
  version: string;
  versions: string[];
  managed_recommended: boolean;
  managed_reason?: string;
  parameters: CatalogParameter[];
  spec: Input;
  homepage?: string;
  notes?: string;
  notes_en?: string;
  resources?: { cpu: number; memory_mb: number };
  deployment_modes?: string[];
  architectures?: string[];
}
export interface BuildContext {
  preview: boolean;
  host_ports: Record<string, number>;
  deployment_mode: string;
}
export interface CatalogDefinition {
  template: CatalogTemplate;
  build: (p: Input, c: BuildContext) => Input;
  validate?: (p: Input, c: BuildContext) => void;
}
type Metadata = Omit<
  CatalogTemplate,
  "spec" | "versions" | "managed_recommended" | "managed_reason"
> &
  Partial<
    Pick<CatalogTemplate, "versions" | "managed_recommended" | "managed_reason">
  >;
export function define(
  meta: Metadata,
  build: CatalogDefinition["build"],
  validate?: CatalogDefinition["validate"],
): CatalogDefinition {
  const preview = Object.fromEntries(
    meta.parameters.map((p) => [
      p.key,
      p.default ??
        p.example ??
        (p.type === "number"
          ? 1
          : p.type === "password" || p.type === "secret"
            ? "[secret:" + p.key + "]"
            : p.format === "url"
              ? "http://app.example.test"
              : p.format === "ip"
                ? "192.0.2.10"
                : p.format === "host"
                  ? "app.example.test"
                  : "app"),
    ]),
  );
  return {
    template: {
      managed_recommended: false,
      managed_reason: "本地数据或固定设备不随故障调度迁移，建议指定机器。",
      resources: { cpu: 1, memory_mb: 1024 },
      ...meta,
      versions: meta.versions ?? [meta.version],
      spec: build(preview, {
        preview: true,
        host_ports: {},
        deployment_mode: "manual",
      }),
    },
    build,
    validate,
  };
}
export function parameters(def: CatalogDefinition, input: unknown): Input {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    fail(400, "invalid_catalog_parameters");
  const source = input as Input,
    out: Input = {};
  const known = new Set([...def.template.parameters.map((p) => p.key), "port"]); // legacy first-port override
  if (Object.keys(source).some((k) => !known.has(k)))
    fail(400, "invalid_catalog_parameter");
  for (const p of def.template.parameters) {
    const v = source[p.key] ?? p.default;
    if (v === undefined || v === "") {
      if (p.required) fail(400, "catalog_parameter_required");
      out[p.key] = "";
      continue;
    }
    if (p.type === "number") {
      if (
        typeof v !== "number" ||
        !Number.isSafeInteger(v) ||
        v < (p.min ?? 0) ||
        v > (p.max ?? 65535)
      )
        fail(400, "invalid_catalog_parameter");
    } else {
      if (
        typeof v !== "string" ||
        v.length > (p.max ?? 4096) ||
        v.length < (p.min ?? 1) ||
        /[\x00\r\n]/.test(v)
      )
        fail(400, "invalid_catalog_parameter");
      if (p.pattern && !new RegExp(p.pattern).test(v))
        fail(400, "invalid_catalog_parameter");
      if (p.options && !p.options.some((o) => o.value === v))
        fail(400, "invalid_catalog_parameter");
      if (p.format === "url") {
        try {
          const u = new URL(v);
          if (
            !["http:", "https:"].includes(u.protocol) ||
            !u.hostname ||
            u.username ||
            u.password ||
            u.search ||
            u.hash ||
            u.pathname !== "/"
          )
            throw Error();
        } catch {
          fail(400, "invalid_catalog_parameter");
        }
      }
      if (p.format === "ip" && !isIP(v)) fail(400, "invalid_catalog_parameter");
      if (
        p.format === "host" &&
        !isIP(v) &&
        (!/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/.test(v) ||
          v
            .split(".")
            .some(
              (x) =>
                !x || x.length > 63 || x.startsWith("-") || x.endsWith("-"),
            ))
      )
        fail(400, "invalid_catalog_parameter");
    }
    out[p.key] = v;
  }
  if (source.port !== undefined && source.port !== null && source.port !== "") {
    if (
      !Number.isInteger(source.port) ||
      source.port < 0 ||
      source.port > 65535
    )
      fail(400, "invalid_catalog_parameter");
    out.port = source.port;
  }
  return out;
}
export const secret = (c: BuildContext, bytes = 32) =>
  c.preview ? "[generated:secret]" : randomBytes(bytes).toString("hex");
export const password = (
  label = "访问密码",
  label_en = "Access password",
  key = "password",
): CatalogParameter => ({
  key,
  label,
  label_en,
  type: "password",
  required: true,
  min: 8,
  max: 256,
});
export const database: CatalogParameter = {
  key: "database",
  label: "数据库名称",
  label_en: "Database name",
  type: "string",
  default: "app",
  pattern: "^[A-Za-z][A-Za-z0-9_]{0,62}$",
  max: 63,
};
export const user: CatalogParameter = {
  key: "user",
  label: "用户名",
  label_en: "Username",
  type: "string",
  default: "lightmoni",
  pattern: "^[A-Za-z][A-Za-z0-9_]{0,30}$",
  max: 31,
};
export const externalURL: CatalogParameter = {
  key: "external_url",
  label: "外部访问 URL",
  label_en: "Public URL",
  type: "string",
  required: true,
  format: "url",
  max: 512,
  description: "填写实际访问地址，端口应与宿主端口一致。",
  description_en: "Use the actual public address and the same published port.",
};
export function port(
  name: string,
  container_port: number,
  service: string,
  app_protocol = "tcp",
  protocol = "tcp",
): Input {
  return {
    name,
    container_port,
    host_port: container_port,
    service,
    protocol,
    app_protocol,
    host_ip: "0.0.0.0",
  };
}
export const volume = (source: string, target: string): Input => ({
  type: "volume",
  source,
  target,
});
export function compose(
  services: Input,
  ports: Input[],
  options: Input = {},
): Input {
  const volumes: Input = {};
  for (const s of Object.values(services) as Input[]) {
    s.restart ??= "unless-stopped";
    for (const v of s.volumes ?? [])
      if (v.type === "volume") volumes[v.source] = {};
  }
  return {
    mode: "compose",
    stateful: Object.keys(volumes).length > 0,
    ports,
    mounts: [],
    compose: {
      services,
      ...(Object.keys(volumes).length ? { volumes } : {}),
      ...options,
    },
  };
}
export const health = (test: string[], start_period = "10s"): Input => ({
  test,
  interval: "10s",
  timeout: "5s",
  retries: 20,
  start_period,
});
export const depends = (...names: string[]): Input =>
  Object.fromEntries(names.map((n) => [n, { condition: "service_healthy" }]));
export function oneShot(service: Input): Input {
  return {
    ...service,
    restart: "no",
    labels: { ...service.labels, "io.lightmoni.platform.oneshot": "true" },
  };
}
export const pg = (
  passwordValue: string,
  db = "app",
  username = "lightmoni",
): Input => ({
  image: "postgres:18.6-bookworm",
  environment: {
    POSTGRES_USER: username,
    POSTGRES_PASSWORD: passwordValue,
    POSTGRES_DB: db,
  },
  volumes: [volume("postgres-data", "/var/lib/postgresql")],
  healthcheck: health([
    "CMD-SHELL",
    'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
  ]),
});
export const redis = (passwordValue: string): Input => ({
  image: "redis:7.4-alpine",
  environment: { REDIS_PASSWORD: passwordValue },
  command: [
    "sh",
    "-c",
    'exec redis-server --appendonly yes --requirepass "$REDIS_PASSWORD"',
  ],
  volumes: [volume("redis-data", "/data")],
  healthcheck: health([
    "CMD-SHELL",
    'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli ping | grep -q PONG',
  ]),
});
export function fixedPorts(c: BuildContext, names: string[]) {
  if (!c.preview && names.some((n) => !c.host_ports[n]))
    fail(400, "catalog_fixed_host_port_required");
}
