import { fail } from "../../shared/http.js";
import {
  compose,
  database,
  define,
  health,
  password,
  pg,
  port,
  user,
  volume,
} from "./types.js";
export const databases = [
  define(
    {
      id: "postgresql",
      name: "PostgreSQL",
      description: "通用关系型数据库，独立持久卷。",
      description_en: "Relational database with isolated persistent storage.",
      category: "database",
      version: "18.6-bookworm",
      homepage: "https://hub.docker.com/_/postgres",
      parameters: [password(), database, user],
    },
    (p) =>
      compose({ postgres: pg(p.password, p.database, p.user) }, [
        port("postgresql", 5432, "postgres"),
      ]),
  ),
  define(
    {
      id: "mariadb",
      name: "MariaDB",
      description: "兼容 MySQL 生态的关系型数据库。",
      description_en:
        "Relational database compatible with the MySQL ecosystem.",
      category: "database",
      version: "11.8.9",
      homepage: "https://hub.docker.com/_/mariadb",
      parameters: [
        password("Root 密码", "Root password"),
        password("应用用户密码", "Application user password", "user_password"),
        database,
        user,
      ],
    },
    (p) =>
      compose(
        {
          mariadb: {
            image: "mariadb:11.8.9",
            environment: {
              MARIADB_ROOT_PASSWORD: p.password,
              MARIADB_DATABASE: p.database,
              MARIADB_USER: p.user,
              MARIADB_PASSWORD: p.user_password,
            },
            volumes: [volume("mariadb-data", "/var/lib/mysql")],
            healthcheck: health([
              "CMD",
              "healthcheck.sh",
              "--connect",
              "--innodb_initialized",
            ]),
          },
        },
        [port("mysql", 3306, "mariadb")],
      ),
    (p) => {
      if (p.user === "root") fail(400, "invalid_catalog_parameter");
    },
  ),
  define(
    {
      id: "mongodb",
      name: "MongoDB",
      description: "文档数据库，启用管理员认证。",
      description_en: "Document database with administrator authentication.",
      category: "database",
      version: "8.0.34",
      homepage: "https://hub.docker.com/_/mongo",
      parameters: [password(), user],
    },
    (p) =>
      compose(
        {
          mongodb: {
            image: "mongo:8.0.34",
            environment: {
              MONGO_INITDB_ROOT_USERNAME: p.user,
              MONGO_INITDB_ROOT_PASSWORD: p.password,
            },
            volumes: [
              volume("mongo-data", "/data/db"),
              volume("mongo-config", "/data/configdb"),
            ],
            healthcheck: health([
              "CMD-SHELL",
              'mongosh --quiet --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "db.adminCommand({ping:1})" >/dev/null',
            ]),
          },
        },
        [port("mongodb", 27017, "mongodb")],
      ),
  ),
  define(
    {
      id: "clickhouse",
      name: "ClickHouse",
      description: "列式分析数据库，支持 HTTP 与原生协议。",
      description_en:
        "Column-oriented analytics database with HTTP and native protocols.",
      category: "database",
      version: "26.8.36.3",
      homepage: "https://clickhouse.com/docs/install/docker",
      resources: { cpu: 2, memory_mb: 2048 },
      parameters: [password(), database, user],
    },
    (p) =>
      compose(
        {
          clickhouse: {
            image: "clickhouse/clickhouse-server:26.8.36.3",
            environment: {
              CLICKHOUSE_DB: p.database,
              CLICKHOUSE_USER: p.user,
              CLICKHOUSE_PASSWORD: p.password,
              CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: "1",
            },
            volumes: [
              volume("clickhouse-data", "/var/lib/clickhouse"),
              volume("clickhouse-logs", "/var/log/clickhouse-server"),
            ],
            ulimits: { nofile: { soft: 262144, hard: 262144 } },
            healthcheck: health([
              "CMD-SHELL",
              'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --query "SELECT 1" >/dev/null',
            ]),
          },
        },
        [
          port("http", 8123, "clickhouse", "http"),
          port("native", 9000, "clickhouse"),
        ],
      ),
  ),
  define(
    {
      id: "elasticsearch",
      name: "Elasticsearch",
      description: "单节点全文搜索与分析引擎，启用访问认证。",
      description_en:
        "Single-node search and analytics engine with authentication.",
      category: "database",
      version: "9.2.6",
      homepage:
        "https://www.elastic.co/docs/deploy-manage/deploy/self-managed/install-elasticsearch-docker-basic",
      resources: { cpu: 2, memory_mb: 2048 },
      notes:
        "单节点；主机 vm.max_map_count 需满足上游要求。HTTP 需通过 HTTPS 网关对外提供。",
      notes_en:
        "Single node. The host must meet upstream vm.max_map_count requirements. Use an HTTPS gateway for public HTTP access.",
      parameters: [password("elastic 用户密码", "elastic password")],
    },
    (p) =>
      compose(
        {
          elasticsearch: {
            image: "docker.elastic.co/elasticsearch/elasticsearch:9.2.6",
            environment: {
              ES_SETTING_DISCOVERY_TYPE: "single-node",
              ES_SETTING_XPACK_SECURITY_ENABLED: "true",
              ES_SETTING_XPACK_SECURITY_HTTP_SSL_ENABLED: "false",
              ELASTIC_PASSWORD: p.password,
              ES_JAVA_OPTS: "-Xms512m -Xmx512m",
            },
            volumes: [
              volume("elasticsearch-data", "/usr/share/elasticsearch/data"),
            ],
            healthcheck: health(
              [
                "CMD-SHELL",
                'curl --fail --silent --user "elastic:$ELASTIC_PASSWORD" "http://127.0.0.1:9200/_cluster/health?wait_for_status=yellow&timeout=5s" >/dev/null',
              ],
              "60s",
            ),
          },
        },
        [port("http", 9200, "elasticsearch", "http")],
      ),
  ),
  define(
    {
      id: "qdrant",
      name: "Qdrant",
      description: "面向 AI 检索的向量数据库，启用 API Key。",
      description_en:
        "Vector database for AI retrieval, protected by an API key.",
      category: "database",
      version: "v1.20.0",
      homepage: "https://qdrant.tech/documentation/guides/installation/",
      parameters: [password("API Key", "API key")],
    },
    (p) =>
      compose(
        {
          qdrant: {
            image: "qdrant/qdrant:v1.20.0",
            environment: { QDRANT__SERVICE__API_KEY: p.password },
            volumes: [volume("qdrant-data", "/qdrant/storage")],
          },
        },
        [port("http", 6333, "qdrant", "http"), port("grpc", 6334, "qdrant")],
      ),
  ),
  define(
    {
      id: "influxdb",
      name: "InfluxDB",
      description: "时序数据库，首次启动初始化组织、Bucket 和管理员。",
      description_en:
        "Time-series database with first-run organization, bucket and admin setup.",
      category: "database",
      version: "2.9.1",
      homepage:
        "https://docs.influxdata.com/influxdb/v2/install/use-docker-compose/",
      parameters: [
        password(),
        password("管理员 Token", "Admin token", "token"),
        user,
        {
          key: "org",
          label: "组织",
          label_en: "Organization",
          type: "string",
          default: "lightmoni",
        },
        {
          key: "bucket",
          label: "Bucket",
          label_en: "Bucket",
          type: "string",
          default: "app",
        },
      ],
    },
    (p) =>
      compose(
        {
          influxdb: {
            image: "influxdb:2.9.1",
            environment: {
              DOCKER_INFLUXDB_INIT_MODE: "setup",
              DOCKER_INFLUXDB_INIT_USERNAME: p.user,
              DOCKER_INFLUXDB_INIT_PASSWORD: p.password,
              DOCKER_INFLUXDB_INIT_ORG: p.org,
              DOCKER_INFLUXDB_INIT_BUCKET: p.bucket,
              DOCKER_INFLUXDB_INIT_ADMIN_TOKEN: p.token,
            },
            volumes: [
              volume("influx-data", "/var/lib/influxdb2"),
              volume("influx-config", "/etc/influxdb2"),
            ],
            healthcheck: health(["CMD", "influx", "ping"]),
          },
        },
        [port("http", 8086, "influxdb", "http")],
      ),
  ),
];
