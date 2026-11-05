import { compose, define, health, password, port, secret, volume } from "./types.js";
import { fail } from "../../shared/http.js";

export const searchStorage = [
  define(
    {
      id: "meilisearch",
      name: "Meilisearch",
      description: "支持即时检索与容错的全文搜索引擎。",
      description_en: "Full-text search engine with instant results and typo tolerance.",
      category: "search",
      architectures: ["amd64", "arm64"],
      version: "v1.56.1",
      homepage: "https://www.meilisearch.com/docs/resources/self_hosting/getting_started/docker",
      notes: "生产模式；主密钥至少 16 个字符。索引、快照和导出保存在独立卷，数据不会随故障调度迁移。",
      notes_en: "Production mode requires a master key of at least 16 characters. Indexes, snapshots and dumps use isolated storage; failover does not migrate data.",
      parameters: [{ ...password("主密钥", "Master key", "master_key"), min: 16 }],
    },
    (p) => compose({
      meilisearch: {
        image: "getmeili/meilisearch:v1.56.1",
        environment: {
          MEILI_ENV: "production",
          MEILI_MASTER_KEY: p.master_key,
          MEILI_NO_ANALYTICS: "true",
          MEILI_HTTP_ADDR: "0.0.0.0:7700",
        },
        volumes: [volume("meili-data", "/meili_data")],
        healthcheck: health(["CMD", "curl", "-fsS", "http://127.0.0.1:7700/health"]),
      },
    }, [port("http", 7700, "meilisearch", "http")]),
  ),
  define(
    {
      id: "searxng",
      name: "SearXNG",
      description: "注重隐私的聚合搜索，提供网页与 JSON 检索接口。",
      description_en: "Privacy-focused metasearch with web and JSON search interfaces.",
      category: "search",
      architectures: ["amd64", "arm64"],
      version: "2026.11.2-cccbc9e15",
      homepage: "https://docs.searxng.org/admin/installation-docker.html",
      resources: { cpu: 1, memory_mb: 512 },
      notes: "无内建访问认证，默认仅本机监听；对外开放请配置网关认证。已启用 HTML / JSON 格式，搜索引擎可用性取决于网络和上游限流。",
      notes_en: "No built-in access authentication; binds to localhost by default. Add gateway authentication before public access. HTML and JSON are enabled; engine availability depends on network access and upstream limits.",
      parameters: [],
    },
    (_p, c) => compose({
      searxng: {
        image: "searxng/searxng:2026.11.2-cccbc9e15",
        environment: { SEARXNG_SECRET: secret(c), SEARXNG_SETTINGS_PATH: "/etc/searxng/settings.yml" },
        // The upstream loader overrides server.secret_key from SEARXNG_SECRET.
        // Keep the generated configuration free of credentials.
        entrypoint: ["/bin/sh", "-ec", "printf '%s\\n' 'use_default_settings: true' 'server:' '  limiter: false' 'search:' '  formats: [html, json]' > /etc/searxng/settings.yml; exec /usr/local/searxng/entrypoint.sh"],
        volumes: [volume("searxng-config", "/etc/searxng"), volume("searxng-data", "/var/cache/searxng")],
        healthcheck: health(["CMD", "/usr/local/searxng/.venv/bin/python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=3)"]),
      },
    }, [{ ...port("http", 8080, "searxng", "http"), host_ip: "127.0.0.1" }]),
  ),
  define(
    {
      id: "rustfs",
      name: "RustFS",
      description: "兼容 S3 的对象存储，附带网页管理控制台。",
      description_en: "S3-compatible object storage with a web management console.",
      category: "storage",
      architectures: ["amd64", "arm64"],
      version: "1.0.4",
      homepage: "https://docs.rustfs.com/en/installation/container",
      resources: { cpu: 2, memory_mb: 2048 },
      notes: "单节点单盘，无冗余；适用于测试和小型工作负载。S3 API 与控制台分别使用 9000 / 9001，数据和日志保存在独立卷。故障调度不复制或迁移数据。",
      notes_en: "Single node and single disk without redundancy, intended for testing and small workloads. S3 API and console use ports 9000 / 9001, with isolated data and log volumes. Failover does not replicate or migrate data.",
      parameters: [
        { key: "access_key", label: "访问密钥", label_en: "Access key", type: "password", required: true, min: 3, max: 128, pattern: "^[A-Za-z0-9_-]{3,128}$", description: "请使用自定义密钥，不使用公开默认值 rustfsadmin。", description_en: "Use custom credentials instead of the public default rustfsadmin." },
        password("秘密密钥", "Secret key", "secret_key"),
      ],
    },
    (p) => compose({
      rustfs: {
        image: "rustfs/rustfs:1.0.4",
        environment: {
          RUSTFS_ACCESS_KEY: p.access_key,
          RUSTFS_SECRET_KEY: p.secret_key,
          RUSTFS_VOLUMES: "/data",
          RUSTFS_ADDRESS: "0.0.0.0:9000",
          RUSTFS_CONSOLE_ADDRESS: "0.0.0.0:9001",
          RUSTFS_CONSOLE_ENABLE: "true",
          RUSTFS_OBS_LOG_DIRECTORY: "/logs",
        },
        volumes: [volume("rustfs-data", "/data"), volume("rustfs-logs", "/logs")],
        healthcheck: health(["CMD-SHELL", "curl -fsS http://127.0.0.1:9000/health && curl -fsS http://127.0.0.1:9001/rustfs/console/health"], "30s"),
      },
    }, [port("s3", 9000, "rustfs", "http"), port("console", 9001, "rustfs", "http")]),
    (p) => {
      if (p.access_key === "rustfsadmin" || p.secret_key === "rustfsadmin") fail(400, "invalid_catalog_parameter");
    },
  ),
];
