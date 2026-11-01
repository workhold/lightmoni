import { fail } from "../../shared/http.js";
import {
  compose,
  define,
  depends,
  externalURL,
  health,
  oneShot,
  password,
  pg,
  port,
  redis,
  secret,
  volume,
  type Input,
} from "./types.js";
const mongoStart = `#!/bin/sh
set -eu
umask 077
printf '%s' "$MONGO_REPLICA_KEY" > /data/db/.lightmoni-replica-key
chown 999:999 /data/db/.lightmoni-replica-key
chmod 400 /data/db/.lightmoni-replica-key
exec docker-entrypoint.sh mongod --replSet rs0 --keyFile /data/db/.lightmoni-replica-key --bind_ip_all
`;
const mongoInit = `const username = encodeURIComponent(process.env.MONGO_INITDB_ROOT_USERNAME);
const password = encodeURIComponent(process.env.MONGO_INITDB_ROOT_PASSWORD);
const admin = new Mongo('mongodb://' + username + ':' + password + '@mongodb:27017/admin?directConnection=true').getDB('admin');
let status;
try { status = admin.runCommand({replSetGetStatus:1}); } catch (e) { if (e.code !== 94) throw e; status = {ok:0,code:94}; }
if (status.ok !== 1) {
 if (status.code !== 94) throw new Error('replica_status_failed');
 const result = admin.runCommand({replSetInitiate:{_id:'rs0',members:[{_id:0,host:'mongodb:27017'}]}});
 if (result.ok !== 1 && result.code !== 23) throw new Error('replica_init_failed');
}
for (let i=0;i<90;i++) { if (admin.runCommand({hello:1}).isWritablePrimary) quit(0); sleep(1000); }
throw new Error('replica_primary_timeout');
`;
export const fastgpt = define(
  {
    id: "fastgpt",
    name: "FastGPT",
    description:
      "AI 知识库与工作流，包含 Mongo 副本集、向量库和模型网关，接入已有 S3 存储。",
    description_en:
      "AI knowledge bases and workflows with Mongo replica set, vector storage, model gateway and an existing S3 store.",
    category: "ai",
    version: "v4.17.2",
    homepage: "https://doc.fastgpt.io/docs/self-host/deploy/docker",
    resources: { cpu: 0.25, memory_mb: 1024 },
    deployment_modes: ["manual"],
    notes:
      "包含 9 个服务（含副本集初始化），需要当前 Agent。root 使用此处设置的密码；重启会按该值重设。需要已有 S3 兼容对象存储并预建公开/私有 Bucket；外部地址需同时被浏览器和容器访问；密钥须可读写两个不同 Bucket，私有 Bucket 禁止匿名读。安装后配置模型、嵌入及系统工具；不启用需要宿主 Docker socket 的自主 Agent 沙箱。",
    notes_en:
      "Includes 9 services (with replica initialization) and requires a current Agent. User root uses this password; restarts reset it to the configured value. Requires an existing S3-compatible object store with public/private buckets created in advance. The public S3 URL must be reachable by browsers and containers. Credentials need read/write access to two distinct buckets; keep the private bucket inaccessible to anonymous users. Configure models, embeddings and system tools after installation. Host-executing Agent sandboxes are disabled.",
    parameters: [
      {
        key: "s3_vendor",
        label: "S3 类型",
        label_en: "S3 provider",
        type: "select",
        default: "aws-s3",
        options: [
          {
            value: "aws-s3",
            label: "S3 兼容存储",
            label_en: "S3-compatible storage",
          },
          { value: "minio", label: "MinIO" },
        ],
      },
      externalURL,
      password("root 初始密码", "Initial root password"),
      {
        ...externalURL,
        key: "s3_url",
        label: "S3 外部访问 URL",
        label_en: "Public S3 URL",
      },
      {
        ...externalURL,
        key: "s3_endpoint",
        label: "S3 服务端 Endpoint",
        label_en: "S3 server endpoint",
      },
      {
        key: "s3_access_key",
        label: "S3 Access Key",
        label_en: "S3 access key",
        type: "string",
        required: true,
        max: 256,
      },
      password("S3 Secret Key", "S3 secret key", "s3_secret_key"),
      {
        key: "s3_region",
        label: "S3 区域",
        label_en: "S3 region",
        type: "string",
        default: "us-east-1",
      },
      {
        key: "public_bucket",
        label: "公开 Bucket",
        label_en: "Public bucket",
        type: "string",
        default: "fastgpt-public",
        pattern: "^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$",
      },
      {
        key: "private_bucket",
        label: "私有 Bucket",
        label_en: "Private bucket",
        type: "string",
        default: "fastgpt-private",
        pattern: "^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$",
      },
    ],
  },
  (p, c) => {
    const dbPassword = secret(c),
      mongoPassword = secret(c),
      redisPassword = secret(c),
      pluginToken = secret(c),
      sandboxToken = secret(c),
      proxyToken = secret(c),
      proxyDbPassword = secret(c);
    const shared: Input = {
      MONGODB_URI: `mongodb://lightmoni:${encodeURIComponent(mongoPassword)}@mongodb:27017/fastgpt?authSource=admin&replicaSet=rs0`,
      DB_MAX_LINK: "20",
      REDIS_URL: `redis://default:${encodeURIComponent(redisPassword)}@redis:6379`,
      STORAGE_VENDOR: p.s3_vendor,
      STORAGE_REGION: p.s3_region,
      STORAGE_ACCESS_KEY_ID: p.s3_access_key,
      STORAGE_SECRET_ACCESS_KEY: p.s3_secret_key,
      STORAGE_PUBLIC_BUCKET: p.public_bucket,
      STORAGE_PRIVATE_BUCKET: p.private_bucket,
      STORAGE_DOWNLOAD_URL_MODE: "short-proxy",
      STORAGE_S3_ENDPOINT: p.s3_endpoint.replace(/\/$/, ""),
      STORAGE_EXTERNAL_ENDPOINT: p.s3_url.replace(/\/$/, ""),
      STORAGE_S3_FORCE_PATH_STYLE: "true",
      LOG_ENABLE_CONSOLE: "true",
      LOG_CONSOLE_LEVEL: "info",
      LOG_ENABLE_OTEL: "false",
      NO_PROXY:
        "localhost,127.0.0.1,app,plugin,code_sandbox,mongodb,redis,vector,aiproxy,proxy_postgres",
    };
    const mongoEnvironment = {
      MONGO_INITDB_ROOT_USERNAME: "lightmoni",
      MONGO_INITDB_ROOT_PASSWORD: mongoPassword,
    };
    const proxyPg = pg(proxyDbPassword, "aiproxy", "aiproxy");
    proxyPg.volumes = [volume("aiproxy-postgres-data", "/var/lib/postgresql")];
    const services: Input = {
      mongodb: {
        image: "mongo:8.0.34",
        entrypoint: ["sh", "/lightmoni/mongo-start.sh"],
        command: [],
        environment: { ...mongoEnvironment, MONGO_REPLICA_KEY: secret(c) },
        volumes: [
          volume("fastgpt-mongo", "/data/db"),
          volume("fastgpt-mongo-config", "/data/configdb"),
        ],
        healthcheck: health(
          [
            "CMD-SHELL",
            'mongosh --quiet --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "db.adminCommand({ping:1})" >/dev/null',
          ],
          "30s",
        ),
      },
      init: oneShot({
        image: "mongo:8.0.34",
        entrypoint: [
          "mongosh",
          "--nodb",
          "--quiet",
          "/lightmoni/init-replica.js",
        ],
        command: [],
        environment: mongoEnvironment,
        depends_on: depends("mongodb"),
      }),
      redis: redis(redisPassword),
      vector: {
        image: "pgvector/pgvector:0.8.0-pg15",
        environment: {
          POSTGRES_USER: "lightmoni",
          POSTGRES_PASSWORD: dbPassword,
          POSTGRES_DB: "postgres",
        },
        volumes: [volume("vector-data", "/var/lib/postgresql/data")],
        healthcheck: health([
          "CMD-SHELL",
          'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
        ]),
      },
      proxy_postgres: proxyPg,
      aiproxy: {
        image: "ghcr.io/labring/aiproxy:v0.7.3",
        environment: {
          ADMIN_KEY: proxyToken,
          SQL_DSN: `postgres://aiproxy:${encodeURIComponent(proxyDbPassword)}@proxy_postgres:5432/aiproxy`,
          RETRY_TIMES: "3",
          BILLING_ENABLED: "false",
          DISABLE_MODEL_CONFIG: "true",
          LOG_DETAIL_STORAGE_HOURS: "1",
        },
        depends_on: depends("proxy_postgres"),
        healthcheck: health([
          "CMD-SHELL",
          "curl --fail --silent http://127.0.0.1:3000/api/status >/dev/null",
        ]),
      },
      plugin: {
        image: "ghcr.io/labring/fastgpt-plugin:v1.1.4",
        environment: {
          ...shared,
          AUTH_TOKEN: pluginToken,
          MAX_API_SIZE: "10",
          SERVICE_REQUEST_MAX_CONTENT_LENGTH: "10",
        },
        depends_on: {
          ...depends("mongodb", "redis"),
          init: { condition: "service_completed_successfully" },
        },
        healthcheck: health(
          [
            "CMD-SHELL",
            "curl --fail --silent http://127.0.0.1:3000/health >/dev/null",
          ],
          "30s",
        ),
      },
      code_sandbox: {
        image: "ghcr.io/labring/fastgpt-code-sandbox:v4.17.0",
        environment: {
          SANDBOX_TOKEN: sandboxToken,
          SANDBOX_API_MAX_BODY_MB: "8",
          SANDBOX_MAX_TIMEOUT: "60000",
          SANDBOX_MAX_MEMORY_MB: "256",
          SANDBOX_MAX_OUTPUT_MB: "10",
          SANDBOX_POOL_SIZE: "2",
          CHECK_INTERNAL_IP: "true",
        },
        security_opt: ["no-new-privileges:true"],
        networks: ["sandbox-net"],
        healthcheck: health(
          [
            "CMD-SHELL",
            "node -e \"fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"",
          ],
          "30s",
        ),
      },
      app: {
        image: "ghcr.io/labring/fastgpt:v4.17.2",
        environment: {
          ...shared,
          HOSTNAME: "0.0.0.0",
          FE_DOMAIN: p.external_url.replace(/\/$/, ""),
          DEFAULT_ROOT_PSW: p.password,
          ROOT_KEY: secret(c),
          FILE_TOKEN_KEY: secret(c),
          AES256_SECRET_KEY: secret(c, 16),
          INVOKE_TOKEN_SECRET: secret(c),
          PG_URL: `postgresql://lightmoni:${encodeURIComponent(dbPassword)}@vector:5432/postgres`,
          PLUGIN_BASE_URL: "http://plugin:3000",
          PLUGIN_TOKEN: pluginToken,
          CODE_SANDBOX_URL: "http://code_sandbox:3000",
          CODE_SANDBOX_TOKEN: sandboxToken,
          AIPROXY_API_ENDPOINT: "http://aiproxy:3000",
          AIPROXY_API_TOKEN: proxyToken,
          AGENT_SANDBOX_PROVIDER: "",
          SYNC_INDEX: "true",
          DATASET_PARSE_MAX_PROCESS: "2",
          VECTOR_MAX_PROCESS: "2",
          QA_MAX_PROCESS: "2",
        },
        networks: ["default", "sandbox-net"],
        depends_on: {
          ...depends(
            "mongodb",
            "redis",
            "vector",
            "plugin",
            "code_sandbox",
            "aiproxy",
          ),
          init: { condition: "service_completed_successfully" },
        },
        healthcheck: health(
          [
            "CMD-SHELL",
            "node -e \"fetch('http://127.0.0.1:3000').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))\"",
          ],
          "60s",
        ),
      },
    };
    const s = compose(services, [port("http", 3000, "app", "http")], {
      networks: { default: {}, "sandbox-net": {} },
    });
    s.mounts.push(
      {
        type: "config",
        service: "mongodb",
        target: "/lightmoni",
        files: { "mongo-start.sh": mongoStart },
      },
      {
        type: "config",
        service: "init",
        target: "/lightmoni",
        files: { "init-replica.js": mongoInit },
      },
    );
    return s;
  },
  (p) => {
    if (p.public_bucket === p.private_bucket)
      fail(400, "catalog_bucket_names_must_differ");
  },
);
