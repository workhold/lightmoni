import {
  compose,
  define,
  depends,
  externalURL,
  health,
  oneShot,
  pg,
  port,
  redis,
  secret,
  volume,
  type Input,
} from "./types.js";
const squidConfig = `http_port 3128
pid_filename /tmp/squid.pid
acl CONNECT method CONNECT
acl SSL_ports port 443
acl Safe_ports port 80 443
acl private_dst dst 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4 ::/128 ::1/128 fc00::/7 fe80::/10
http_access deny !Safe_ports
http_access deny CONNECT !SSL_ports
http_access deny private_dst
http_access allow all
cache deny all
access_log stdio:/dev/stdout
cache_log /dev/stderr
coredump_dir /tmp
`;
const nginxConfig = `server {
 listen 80;
 client_max_body_size 100m;
 proxy_http_version 1.1;
 proxy_set_header Host $host;
 proxy_set_header X-Real-IP $remote_addr;
 proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
 proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
 proxy_read_timeout 600s;
 proxy_buffering off;
 location ~ ^/(console/api|api|v1|files|mcp|triggers)(/|$) { proxy_pass http://api:5001; }
 location /e/ { proxy_set_header Dify-Hook-Url $scheme://$host$request_uri; proxy_pass http://plugin_daemon:5002; }
 location / { proxy_pass http://web:3000; }
}
`;
export const dify = define(
  {
    id: "dify",
    name: "Dify",
    description: "AI 工作流与知识库平台，包含数据库、向量库、插件和代码沙箱。",
    description_en:
      "AI workflows and RAG with database, vector storage, plugins and a code sandbox.",
    category: "ai",
    version: "1.14.2",
    homepage: "https://docs.dify.ai/en/self-host/quick-start/docker-compose",
    resources: { cpu: 0.25, memory_mb: 1024 },
    notes:
      "包含 12 个服务（含初始化）。首次访问 /install 创建管理员，再配置模型和嵌入服务；需要当前 Agent。外部 URL 可由 HTTPS 网关提供。未启用自主 Agent 宿主执行和协同编辑。",
    notes_en:
      "Includes 12 services (with initialization). Visit /install to create the administrator, then configure chat and embedding providers. Requires a current Agent. Use an HTTPS gateway for the public URL. Host-executing autonomous agents and collaborative editing are disabled.",
    parameters: [externalURL],
  },
  (p, c) => {
    const dbPassword = secret(c),
      redisPassword = secret(c),
      vectorKey = secret(c),
      sandboxKey = secret(c),
      pluginKey = secret(c),
      innerKey = secret(c);
    const origin = p.external_url.replace(/\/$/, "");
    const shared: Input = {
      DEPLOY_ENV: "PRODUCTION",
      EDITION: "SELF_HOSTED",
      SECRET_KEY: secret(c),
      DB_TYPE: "postgresql",
      DB_HOST: "postgres",
      DB_PORT: "5432",
      DB_USERNAME: "postgres",
      DB_PASSWORD: dbPassword,
      DB_DATABASE: "dify",
      REDIS_HOST: "redis",
      REDIS_PORT: "6379",
      REDIS_PASSWORD: redisPassword,
      REDIS_DB: "0",
      CELERY_BROKER_URL: `redis://:${encodeURIComponent(redisPassword)}@redis:6379/1`,
      CELERY_BACKEND: "redis",
      STORAGE_TYPE: "opendal",
      OPENDAL_SCHEME: "fs",
      OPENDAL_FS_ROOT: "storage",
      VECTOR_STORE: "qdrant",
      QDRANT_URL: "http://qdrant:6333",
      QDRANT_API_KEY: vectorKey,
      CODE_EXECUTION_ENDPOINT: "http://sandbox:8194",
      CODE_EXECUTION_API_KEY: sandboxKey,
      SSRF_PROXY_HTTP_URL: "http://ssrf_proxy:3128",
      SSRF_PROXY_HTTPS_URL: "http://ssrf_proxy:3128",
      PLUGIN_DAEMON_URL: "http://plugin_daemon:5002",
      PLUGIN_DAEMON_KEY: pluginKey,
      INNER_API_KEY_FOR_PLUGIN: innerKey,
      PLUGIN_DIFY_INNER_API_KEY: innerKey,
      PLUGIN_DIFY_INNER_API_URL: "http://api:5001",
      ENDPOINT_URL_TEMPLATE: origin + "/e/{hook_id}",
      ENABLE_COLLABORATION_MODE: "false",
      CONSOLE_API_URL: origin,
      CONSOLE_WEB_URL: origin,
      APP_API_URL: origin,
      APP_WEB_URL: origin,
      SERVICE_API_URL: origin,
      FILES_URL: origin,
      INTERNAL_FILES_URL: "http://api:5001",
      CELERY_WORKER_AMOUNT: "1",
    };
    const apiBase = {
      image: "langgenius/dify-api:1.14.2",
      volumes: [volume("dify-storage", "/app/api/storage")],
      networks: ["default", "sandbox-net"],
    };
    const services: Input = {
      init: oneShot({
        image: "busybox:1.37.0",
        command: ["sh", "-ec", "chown -R 1001:1001 /storage"],
        volumes: [volume("dify-storage", "/storage")],
      }),
      postgres: pg(dbPassword, "dify", "postgres"),
      redis: redis(redisPassword),
      qdrant: {
        image: "qdrant/qdrant:v1.20.0",
        environment: { QDRANT__SERVICE__API_KEY: vectorKey },
        volumes: [volume("qdrant-data", "/qdrant/storage")],
      },
      api: {
        ...apiBase,
        environment: { ...shared, MODE: "api", MIGRATION_ENABLED: "true" },
        depends_on: {
          ...depends("postgres", "redis"),
          init: { condition: "service_completed_successfully" },
          qdrant: { condition: "service_started" },
          sandbox: { condition: "service_started" },
          plugin_daemon: { condition: "service_started" },
        },
        healthcheck: health(
          [
            "CMD-SHELL",
            "python -c \"import urllib.request; urllib.request.urlopen('http://127.0.0.1:5001/health')\"",
          ],
          "120s",
        ),
      },
      worker: {
        ...apiBase,
        environment: { ...shared, MODE: "worker", MIGRATION_ENABLED: "false" },
        depends_on: depends("api"),
      },
      worker_beat: {
        ...apiBase,
        environment: { ...shared, MODE: "beat", MIGRATION_ENABLED: "false" },
        depends_on: depends("api"),
      },
      web: {
        image: "langgenius/dify-web:1.14.2",
        environment: {
          CONSOLE_API_URL: origin,
          APP_API_URL: origin,
          NEXT_TELEMETRY_DISABLED: "1",
        },
      },
      plugin_daemon: {
        image: "langgenius/dify-plugin-daemon:0.6.1-local",
        environment: {
          DB_TYPE: "postgresql",
          DB_HOST: "postgres",
          DB_PORT: "5432",
          DB_USERNAME: "postgres",
          DB_PASSWORD: dbPassword,
          DB_DATABASE: "dify_plugin",
          DB_SSL_MODE: "disable",
          REDIS_HOST: "redis",
          REDIS_PORT: "6379",
          REDIS_PASSWORD: redisPassword,
          REDIS_DB: "0",
          SERVER_PORT: "5002",
          SERVER_KEY: pluginKey,
          DIFY_INNER_API_URL: "http://api:5001",
          DIFY_INNER_API_KEY: innerKey,
          PLUGIN_WORKING_PATH: "/app/storage/cwd",
          PLUGIN_STORAGE_TYPE: "local",
          PLUGIN_STORAGE_LOCAL_ROOT: "/app/storage",
          FORCE_VERIFYING_SIGNATURE: "true",
        },
        volumes: [volume("dify-plugins", "/app/storage")],
        depends_on: depends("postgres", "redis"),
      },
      sandbox: {
        image: "langgenius/dify-sandbox:0.2.15",
        environment: {
          API_KEY: sandboxKey,
          GIN_MODE: "release",
          WORKER_TIMEOUT: "15",
          ENABLE_NETWORK: "true",
          HTTP_PROXY: "http://ssrf_proxy:3128",
          HTTPS_PROXY: "http://ssrf_proxy:3128",
          SANDBOX_PORT: "8194",
        },
        volumes: [volume("dify-sandbox-dependencies", "/dependencies")],
        networks: ["sandbox-net"],
        depends_on: ["ssrf_proxy"],
      },
      ssrf_proxy: {
        image:
          "ubuntu/squid@sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029",
        entrypoint: ["/usr/sbin/squid"],
        command: ["-N", "-f", "/etc/squid/squid.conf"],
        networks: ["default", "sandbox-net"],
      },
      nginx: {
        image: "nginx:1.30.6-alpine",
        depends_on: {
          ...depends("api"),
          web: { condition: "service_started" },
          plugin_daemon: { condition: "service_started" },
        },
      },
    };
    const s = compose(services, [port("http", 80, "nginx", "http")], {
      networks: { default: {}, "sandbox-net": { internal: true } },
    });
    s.mounts.push(
      {
        type: "config",
        service: "nginx",
        target: "/etc/nginx/conf.d",
        files: { "default.conf": nginxConfig },
      },
      {
        type: "config",
        service: "ssrf_proxy",
        target: "/etc/squid",
        files: { "squid.conf": squidConfig },
      },
    );
    return s;
  },
);
