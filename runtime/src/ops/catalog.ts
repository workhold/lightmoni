import { fail } from "../shared/http.js";
import {registryTemplateSpec} from './registry-runtime.js';

type Input = Record<string, any>;
export const applicationCatalog = [
  {id:'registry',name:'Docker Registry',description:'独立持久数据的私有镜像仓库；系统镜像缓存请从私有镜像管理安装。',category:'tools',version:'3.0.0',versions:['3.0.0'],managed_recommended:false,managed_reason:'本地仓库数据不会自动跨机迁移，建议明确指定机器。',parameters:[],spec:{...registryTemplateSpec(),compose:{services:{registry:registryTemplateSpec().compose.services.registry}},ports:registryTemplateSpec().ports.slice(0,1),mounts:registryTemplateSpec().mounts.slice(0,1)}},
  {
    id: "mysql",
    name: "MySQL",
    description: "独立数据目录的 MySQL 数据库，多套安装互不共享数据。",
    category: "database",
    version: "8.4",
    versions: ["8.4"],
    managed_recommended: false,
    managed_reason:
      "依赖本机持久数据；副本调度不会建立数据库复制或搬迁数据，建议手动模式。",
    parameters: [
      { key: "password", label: "Root 密码", type: "password", required: true },
      { key: "database", label: "数据库", type: "string", default: "app" },
      { key: "user", label: "应用用户", type: "string", default: "lightmoni" },
      {
        key: "user_password",
        label: "应用用户密码",
        type: "password",
        required: true,
      },
      {
        key: "port",
        label: "宿主端口（0 自动分配）",
        type: "number",
        default: 0,
      },
    ],
    spec: {
      mode: "compose",
      stateful: true,
      ports: [
        {
          name: "mysql",
          container_port: 3306,
          host_port: 0,
          protocol: "tcp",
          app_protocol: "tcp",
          service: "mysql",
        },
      ],
      compose: {
        services: {
          mysql: {
            image: "mysql:8.4",
            environment: {
              MYSQL_ROOT_PASSWORD: "[secret:password]",
              MYSQL_DATABASE: "app",
              MYSQL_USER: "lightmoni",
              MYSQL_PASSWORD: "[secret:user_password]",
            },
          },
        },
      },
      mounts: [{ type: "data", service: "mysql", target: "/var/lib/mysql" }],
    },
  },
  {
    id: "openresty",
    name: "OpenResty",
    description:
      "全局共享的网站入口，可部署到多个集群，监听 80/443。",
    category: "web",
    version: "1.27.1.2-0-alpine",
    versions: ["1.27.1.2-0-alpine"],
    managed_recommended: true,
    managed_reason:
      "无状态入口支持托管：固定监听 80/443，冲突节点跳过，换机验证成功后更新集群入口域名解析。",
    parameters: [],
    spec: {
      mode: "container",
      role: "openresty",
      network_mode: "host",
      image: "openresty/openresty:1.27.1.2-0-alpine",
      ports: [
        {
          name: "http",
          container_port: 80,
          host_port: 80,
          protocol: "tcp",
          app_protocol: "http",
        },
        {
          name: "https",
          container_port: 443,
          host_port: 443,
          protocol: "tcp",
          app_protocol: "https",
        },
      ],
      mounts: [],
    },
  },
  {
    id: "redis",
    name: "Redis",
    description: "可独立安装多套 Redis，默认启用 AOF 并保留本机数据。",
    category: "cache",
    version: "7.4-alpine",
    versions: ["7.4-alpine"],
    managed_recommended: false,
    managed_reason:
      "默认启用本机持久化；故障调度不会复制数据或建立 Redis 主从。",
    parameters: [
      { key: "password", label: "访问密码", type: "password", required: true },
      {
        key: "port",
        label: "宿主端口（0 自动分配）",
        type: "number",
        default: 0,
      },
    ],
    spec: {
      mode: "container",
      stateful: true,
      image: "redis:7.4-alpine",
      command: [
        "sh",
        "-c",
        'exec redis-server --appendonly yes --requirepass "$REDIS_PASSWORD"',
      ],
      environment: { REDIS_PASSWORD: "[secret:password]" },
      ports: [
        {
          name: "redis",
          container_port: 6379,
          host_port: 0,
          protocol: "tcp",
          app_protocol: "tcp",
        },
      ],
      mounts: [{ type: "data", target: "/data" }],
    },
  },
];
export function catalogTemplate(id: string) {
  const template = applicationCatalog.find((t) => t.id === id);
  if (!template) fail(404, "application_template_not_found");
  return template;
}
export function catalogInstallation(id: string, input: Input) {
  const template = catalogTemplate(id),
    p = input.parameters ?? {};
  if (!p || typeof p !== "object" || Array.isArray(p))
    fail(400, "invalid_catalog_parameters");
  for (const parameter of template.parameters)
    if (
      parameter.required &&
      (typeof p[parameter.key] !== "string" ||
        !p[parameter.key] ||
        p[parameter.key].length > 4096)
    )
      fail(400, "catalog_parameter_required");
  const version = input.version ?? template.version;
  if (!template.versions.includes(version))
    fail(400, "unsupported_template_version");
  const spec: Input = structuredClone(template.spec);
  if (id === "mysql") {
    const database = p.database ?? "app",
      user = p.user ?? "lightmoni";
    if (
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(database) ||
      !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(user) ||
      user === "root"
    )
      fail(400, "invalid_database_identity");
    const service: Input = spec.compose.services.mysql;
    service.environment = {
      MYSQL_ROOT_PASSWORD: p.password,
      MYSQL_DATABASE: database,
      MYSQL_USER: user,
      MYSQL_PASSWORD: p.user_password,
    };
    service.restart = "unless-stopped";
    service.healthcheck = {
      test: [
        "CMD-SHELL",
        "MYSQL_PWD=\"$MYSQL_ROOT_PASSWORD\" mysql -h127.0.0.1 -uroot --execute 'SELECT 1' >/dev/null 2>&1",
      ],
      interval: "2s",
      timeout: "3s",
      retries: 45,
      start_period: "5s",
    };
  }
  if (id === "redis") spec.environment.REDIS_PASSWORD = p.password;
  if (spec.ports.length && id !== 'openresty')
    spec.ports[0].host_port = p.port !== undefined && p.port !== null && p.port !== ''
      ? p.port : input.deployment_mode === 'managed' ? 0 : spec.ports[0].container_port;
  return {
    template,
    name: input.name ?? template.name,
    spec: {
      ...spec,
      service_name: input.service_name,
      source: {
        type: "store",
        template_id: template.id,
        template_version: version,
      },
      role: id === "openresty" ? "openresty" : "generic",
      deployment_mode: input.deployment_mode ?? "manual",
      deployments: input.deployments ?? [],
      stateful: id !== "openresty",
    },
  };
}

export const applicationCategories = [
  {id:'database',name:'数据库',name_en:'Databases'},
  {id:'cache',name:'缓存',name_en:'Caching'},
  {id:'tools',name:'工具',name_en:'Tools'},
  {id:'web',name:'网站与网关',name_en:'Web & gateways'},
].map(c=>({...c,count:applicationCatalog.filter(t=>t.category===c.id).length}));
