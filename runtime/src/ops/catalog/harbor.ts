import { createHash } from "node:crypto";
import { fail } from "../../shared/http.js";
import {
  compose,
  define,
  depends,
  externalURL,
  fixedPorts,
  oneShot,
  password,
  port,
  secret,
  volume,
  type Input,
} from "./types.js";
import { prepareScript, envLoader } from "./harbor-scripts.js";
const version = "v2.14.6",
  image = (name: string) => "goharbor/" + name + ":" + version;
const sub = (
  source: string,
  path: string,
  target: string,
  read_only = false,
): Input => ({
  ...volume(source, target),
  volume: { subpath: path },
  read_only,
});
const prepared = { prepare: { condition: "service_completed_successfully" } };
export const harbor = define(
  {
    id: "harbor",
    name: "Harbor",
    description: "完整私有镜像仓库，包含认证、项目、数据库和任务服务。",
    description_en:
      "Private image registry with authentication, projects, database and job services.",
    category: "devops",
    version,
    homepage: "https://goharbor.io/docs/2.14.0/install-config/",
    resources: { cpu: 0.25, memory_mb: 1024 },
    deployment_modes: ["manual"],
    architectures: ["amd64"],
    notes:
      "仅支持 amd64；需要 Docker Engine 26+、Compose 2.26+ 和当前 LightMoni Agent。初始管理员 admin。本配方在内部提供 HTTP，外部 HTTPS 由网关终止；不包含 Trivy 扫描。",
    notes_en:
      "amd64 only. Requires Docker Engine 26+, Compose 2.26+ and a current LightMoni Agent. Initial user: admin. Internal HTTP requires an external HTTPS gateway for public access. Trivy scanning is not included.",
    parameters: [
      externalURL,
      password("管理员初始密码", "Initial administrator password"),
    ],
  },
  (p, c) => {
    const dbPassword = secret(c),
      revision = createHash("sha256")
        .update(
          JSON.stringify([p.external_url, p.password, dbPassword, version]),
        )
        .digest("hex");
    const environment = { LIGHTMONI_HARBOR_CONFIG_REVISION: revision };
    const common = { environment, depends_on: prepared };
    const services: Input = {
      prepare: oneShot({
        image: image("prepare"),
        entrypoint: ["python3", "/lightmoni/prepare.py"],
        command: [],
        environment: {
          HARBOR_PUBLIC_URL: p.external_url,
          HARBOR_ADMIN_PASSWORD: p.password,
          HARBOR_DB_PASSWORD: dbPassword,
        },
        volumes: [
          volume("harbor-config", "/config"),
          volume("harbor-data", "/data"),
        ],
      }),
      postgresql: {
        ...common,
        image: image("harbor-db"),
        environment: { ...environment, POSTGRES_PASSWORD: dbPassword },
        shm_size: "256m",
        volumes: [sub("harbor-data", "database", "/var/lib/postgresql/data")],
      },
      redis: {
        ...common,
        image: image("redis-photon"),
        volumes: [sub("harbor-data", "redis", "/var/lib/redis")],
      },
      registry: {
        ...common,
        image: image("registry-photon"),
        volumes: [
          sub("harbor-config", "registry", "/etc/registry", true),
          sub("harbor-data", "registry", "/storage"),
          sub("harbor-data", "secret", "/run/harbor-secret", true),
        ],
      },
      registryctl: {
        ...common,
        image: image("harbor-registryctl"),
        entrypoint: [
          "/bin/sh",
          "-ec",
          envLoader,
          "--",
          "/etc/registryctl/env",
          "/home/harbor/start.sh",
        ],
        command: [],
        volumes: [
          sub("harbor-config", "registryctl", "/etc/registryctl", true),
          sub("harbor-config", "registry", "/etc/registry", true),
          sub("harbor-data", "registry", "/storage"),
          sub("harbor-data", "secret", "/run/harbor-secret", true),
        ],
      },
      core: {
        image: image("harbor-core"),
        environment,
        depends_on: {
          ...prepared,
          ...depends("postgresql", "redis"),
          registry: { condition: "service_started" },
        },
        entrypoint: [
          "/bin/sh",
          "-ec",
          envLoader,
          "--",
          "/etc/core/env",
          "/harbor/entrypoint.sh",
        ],
        command: [],
        volumes: [
          sub("harbor-config", "core", "/etc/core", true),
          volume("harbor-data", "/data"),
          sub("harbor-data", "secret", "/run/harbor-secret", true),
        ],
      },
      jobservice: {
        image: image("harbor-jobservice"),
        environment,
        depends_on: { ...prepared, ...depends("core") },
        entrypoint: [
          "/bin/sh",
          "-ec",
          envLoader,
          "--",
          "/etc/jobservice/env",
          "/harbor/entrypoint.sh",
        ],
        command: [],
        volumes: [
          sub("harbor-config", "jobservice", "/etc/jobservice", true),
          sub("harbor-data", "job_logs", "/var/log/jobs"),
        ],
      },
      portal: {
        ...common,
        image: image("harbor-portal"),
        entrypoint: [
          "nginx",
          "-c",
          "/run/harbor-portal-config/nginx.conf",
          "-g",
          "daemon off;",
        ],
        command: [],
        volumes: [
          sub("harbor-config", "portal", "/run/harbor-portal-config", true),
        ],
      },
      proxy: {
        image: image("nginx-photon"),
        environment,
        depends_on: {
          ...prepared,
          ...depends("core", "registry", "portal"),
          jobservice: { condition: "service_started" },
        },
        volumes: [sub("harbor-config", "nginx", "/etc/nginx", true)],
      },
    };
    const s = compose(services, [port("http", 8080, "proxy", "http")]);
    s.mounts.push({
      type: "config",
      service: "prepare",
      target: "/lightmoni",
      files: { "prepare.py": prepareScript },
    });

    return s;
  },
  (p, c) => {
    fixedPorts(c, ["http"]);
    if (new URL(p.external_url).pathname !== "/")
      fail(400, "invalid_catalog_parameter");
  },
);
