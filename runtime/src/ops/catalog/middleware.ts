import { fail } from "../../shared/http.js";
import {
  compose,
  define,
  fixedPorts,
  health,
  oneShot,
  password,
  port,
  secret,
  user,
  volume,
} from "./types.js";
export const middleware = [
  define(
    {
      id: "rabbitmq",
      name: "RabbitMQ",
      description: "AMQP 消息队列，包含管理控制台。",
      description_en: "AMQP message broker with a management console.",
      category: "middleware",
      version: "4.3.7-management-alpine",
      homepage: "https://www.rabbitmq.com/docs/download",
      parameters: [password(), user],
    },
    (p, c) =>
      compose(
        {
          rabbitmq: {
            image: "rabbitmq:4.3.7-management-alpine",
            hostname: "rabbitmq",
            environment: {
              RABBITMQ_DEFAULT_USER: p.user,
              RABBITMQ_DEFAULT_PASS: p.password,
              RABBITMQ_ERLANG_COOKIE: secret(c),
            },
            volumes: [volume("rabbitmq-data", "/var/lib/rabbitmq")],
            healthcheck: health(
              ["CMD", "rabbitmq-diagnostics", "-q", "ping"],
              "30s",
            ),
          },
        },
        [
          port("amqp", 5672, "rabbitmq"),
          port("management", 15672, "rabbitmq", "http"),
        ],
      ),
  ),
  define(
    {
      id: "nacos",
      name: "Nacos",
      description: "单机服务注册与配置中心，启用认证。",
      description_en:
        "Standalone service discovery and configuration server with authentication.",
      category: "middleware",
      version: "v2.5.5",
      homepage:
        "https://nacos.io/en/docs/latest/quickstart/quick-start-docker/",
      resources: { cpu: 1, memory_mb: 1024 },
      deployment_modes: ["manual"],
      notes:
        "首次访问 /nacos 初始化管理员密码。gRPC 宿主端口必须等于 API 宿主端口 +1000。单机内置存储，无数据库复制。",
      notes_en:
        "Initialize the admin password on the first visit to /nacos. The published gRPC port must equal the API port +1000. Embedded storage; no replication.",
      parameters: [],
    },
    (_p, c) =>
      compose(
        {
          nacos: {
            image: "nacos/nacos-server:v2.5.5",
            environment: {
              MODE: "standalone",
              PREFER_HOST_MODE: "hostname",
              NACOS_AUTH_ENABLE: "true",
              NACOS_AUTH_TOKEN: c.preview
                ? "[generated:base64-token]"
                : Buffer.from(secret(c)).toString("base64"),
              NACOS_AUTH_IDENTITY_KEY: "lightmoni",
              NACOS_AUTH_IDENTITY_VALUE: secret(c),
              JVM_XMS: "256m",
              JVM_XMX: "512m",
              JVM_XMN: "128m",
            },
            volumes: [
              volume("nacos-data", "/home/nacos/data"),
              volume("nacos-logs", "/home/nacos/logs"),
            ],
            healthcheck: health(
              [
                "CMD-SHELL",
                "curl --fail --silent http://127.0.0.1:8848/nacos/v1/console/health/readiness >/dev/null",
              ],
              "60s",
            ),
          },
        },
        [port("http", 8848, "nacos", "http"), port("grpc", 9848, "nacos")],
      ),
    (_p, c) => {
      fixedPorts(c, ["http", "grpc"]);
      if (!c.preview && c.host_ports.grpc !== c.host_ports.http + 1000)
        fail(400, "catalog_nacos_grpc_port_offset");
    },
  ),
  define(
    {
      id: "emqx",
      name: "EMQX",
      description: "MQTT 消息服务器，提供 WebSocket 和管理控制台。",
      description_en:
        "MQTT broker with WebSocket support and a management dashboard.",
      category: "middleware",
      version: "6.3.2",
      homepage:
        "https://docs.emqx.com/en/emqx/latest/deploy/install-docker.html",
      notes:
        "管理员用户为 admin；客户端认证和访问控制需在控制台配置后再接入业务。",
      notes_en:
        "The dashboard user is admin. Configure MQTT client authentication and access rules in the dashboard before connecting workloads.",
      parameters: [password("控制台密码", "Dashboard password")],
    },
    (p, c) =>
      compose(
        {
          emqx: {
            image: "emqx/emqx:6.3.2",
            hostname: "emqx.local",
            environment: {
              EMQX_NODE__NAME: "emqx@emqx.local",
              EMQX_NODE__COOKIE: secret(c),
              EMQX_DASHBOARD__DEFAULT_PASSWORD: p.password,
            },
            volumes: [
              volume("emqx-data", "/opt/emqx/data"),
              volume("emqx-log", "/opt/emqx/log"),
            ],
            healthcheck: health(
              ["CMD", "/opt/emqx/bin/emqx", "ctl", "status"],
              "30s",
            ),
          },
        },
        [
          { ...port("mqtt", 1883, "emqx"), host_ip: "127.0.0.1" },
          { ...port("websocket", 8083, "emqx", "http"), host_ip: "127.0.0.1" },
          port("dashboard", 18083, "emqx", "http"),
        ],
      ),
  ),
  define(
    {
      id: "memcached",
      name: "Memcached",
      description: "轻量内存缓存，禁用 UDP，默认仅本机访问。",
      description_en:
        "Lightweight in-memory cache with UDP disabled and localhost binding by default.",
      category: "middleware",
      version: "1.6.45-alpine",
      homepage: "https://hub.docker.com/_/memcached",
      resources: { cpu: 0.25, memory_mb: 128 },
      notes: "不包含认证或持久化。仅供可信网络使用；清空或重启会丢失缓存。",
      notes_en:
        "No authentication or persistence. Use only on a trusted network; restarts discard cached data.",
      parameters: [
        {
          key: "cache_mb",
          label: "缓存容量（MiB）",
          label_en: "Cache size (MiB)",
          type: "number",
          default: 64,
          min: 16,
          max: 1048576,
        },
      ],
    },
    (p) =>
      compose(
        {
          memcached: {
            image: "memcached:1.6.45-alpine",
            command: [
              "memcached",
              "-m",
              String(p.cache_mb),
              "-I",
              "2m",
              "-U",
              "0",
            ],
          },
        },
        [{ ...port("memcached", 11211, "memcached"), host_ip: "127.0.0.1" }],
      ),
  ),
  define(
    {
      id: "kafka",
      name: "Kafka",
      description: "使用 KRaft 的单节点消息流平台，外部监听启用 SASL。",
      description_en:
        "Single-node KRaft event streaming with SASL on the external listener.",
      category: "middleware",
      version: "4.4.0",
      homepage: "https://hub.docker.com/r/apache/kafka",
      resources: { cpu: 2, memory_mb: 2048 },
      deployment_modes: ["manual"],
      notes:
        "使用管理员用户名 admin。必须填写客户端可达的主机地址和固定宿主端口；SASL_PLAINTEXT 不加密链路，仅供可信网络或加密隧道。单节点不提供高可用。",
      notes_en:
        "The SASL username is admin. Set a client-reachable host and a fixed published port. SASL_PLAINTEXT requires a trusted network or encrypted tunnel. This is a single node without HA.",
      parameters: [
        password(),
        {
          key: "advertised_host",
          label: "客户端可达主机",
          label_en: "Client-reachable host",
          type: "string",
          format: "host",
          required: true,
        },
      ],
    },
    (p, c) =>
      compose(
        {
          kafka: {
            image: "apache/kafka:4.4.0",
            hostname: "kafka",
            environment: {
              CLUSTER_ID: c.preview
                ? "[generated:kafka-cluster-id]"
                : Buffer.from(secret(c, 16), "hex").toString("base64url"),
              KAFKA_NODE_ID: "1",
              KAFKA_PROCESS_ROLES: "broker,controller",
              KAFKA_LISTENERS:
                "INTERNAL://:9092,CONTROLLER://:9093,EXTERNAL://:9094",
              KAFKA_ADVERTISED_LISTENERS: `INTERNAL://kafka:9092,EXTERNAL://${p.advertised_host}:${c.host_ports.kafka ?? 9094}`,
              KAFKA_LISTENER_SECURITY_PROTOCOL_MAP:
                "CONTROLLER:PLAINTEXT,INTERNAL:PLAINTEXT,EXTERNAL:SASL_PLAINTEXT",
              KAFKA_INTER_BROKER_LISTENER_NAME: "INTERNAL",
              KAFKA_CONTROLLER_LISTENER_NAMES: "CONTROLLER",
              KAFKA_CONTROLLER_QUORUM_VOTERS: "1@kafka:9093",
              KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: "1",
              KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: "1",
              KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: "1",
              KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: "0",
              KAFKA_LOG_DIRS: "/var/lib/kafka/data",
              KAFKA_SASL_ENABLED_MECHANISMS: "PLAIN",
              KAFKA_LISTENER_NAME_EXTERNAL_PLAIN_SASL_JAAS_CONFIG: `org.apache.kafka.common.security.plain.PlainLoginModule required username="admin" password=${JSON.stringify(p.password)} user_admin=${JSON.stringify(p.password)};`,
            },
            volumes: [volume("kafka-data", "/var/lib/kafka/data")],
            healthcheck: health(
              [
                "CMD-SHELL",
                "/opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:9092 --list >/dev/null",
              ],
              "30s",
            ),
          },
        },
        [port("kafka", 9094, "kafka")],
      ),
    (_p, c) => fixedPorts(c, ["kafka"]),
  ),
  define(
    {
      id: "rocketmq",
      name: "RocketMQ",
      description: "单节点消息队列，包含 NameServer 与 Broker。",
      description_en: "Single-node message queue with NameServer and Broker.",
      category: "middleware",
      version: "5.5.0",
      homepage:
        "https://rocketmq.apache.org/docs/quickStart/02quickstartWithDocker/",
      resources: { cpu: 2, memory_mb: 2048 },
      deployment_modes: ["manual"],
      notes:
        "填写客户端可达的 Broker IPv4；Broker、HA 和快速连接使用固定的 10911/10912/10909 宿主端口。单节点不提供复制。",
      notes_en:
        "Set the client-reachable broker IPv4 address. Broker, HA and fast connections require fixed host ports 10911/10912/10909. No replication.",
      parameters: [
        { ...password(), pattern: "^[A-Za-z0-9@_!%+=.-]{8,128}$", max: 128 },
        user,
        {
          key: "broker_ip",
          label: "Broker IPv4",
          label_en: "Broker IPv4",
          type: "string",
          format: "ip",
          pattern: "^[0-9.]+$",
          required: true,
        },
      ],
    },
    (p) => {
      const auth = JSON.stringify({ username: p.user, password: p.password });
      const common = {
        image: "apache/rocketmq:5.5.0",
        environment: { JAVA_OPT_EXT: "-Xms256m -Xmx512m -Xmn128m" },
      };
      return compose(
        {
          init: oneShot({
            image: "busybox:1.37.0",
            command: [
              "sh",
              "-ec",
              "chown -R 3000:3000 /store /broker-logs /namesrv-logs",
            ],
            volumes: [
              volume("broker-data", "/store"),
              volume("broker-logs", "/broker-logs"),
              volume("namesrv-logs", "/namesrv-logs"),
            ],
          }),
          namesrv: {
            ...common,
            depends_on: {
              init: { condition: "service_completed_successfully" },
            },
            command: ["sh", "mqnamesrv"],
            volumes: [volume("namesrv-logs", "/home/rocketmq/logs")],
          },
          broker: {
            ...common,
            environment: {
              ...common.environment,
              BROKER_IP: p.broker_ip,
              AUTH_JSON: auth,
              INNER_AUTH_JSON: JSON.stringify({
                accessKey: p.user,
                secretKey: p.password,
              }),
            },
            command: [
              "sh",
              "-ec",
              'umask 077; printf "brokerClusterName=DefaultCluster\nbrokerName=broker-a\nbrokerId=0\nnamesrvAddr=namesrv:9876\nstorePathRootDir=/home/rocketmq/store\nstorePathCommitLog=/home/rocketmq/store/commitlog\n" > /tmp/broker.conf; printf "brokerIP1=%s\nauthenticationEnabled=true\nauthenticationMetadataProvider=org.apache.rocketmq.auth.authentication.provider.LocalAuthenticationMetadataProvider\nauthorizationEnabled=true\nauthorizationMetadataProvider=org.apache.rocketmq.auth.authorization.provider.LocalAuthorizationMetadataProvider\ninitAuthenticationUser=%s\ninnerClientAuthenticationCredentials=%s\n" "$BROKER_IP" "$AUTH_JSON" "$INNER_AUTH_JSON" >> /tmp/broker.conf; exec sh mqbroker -n namesrv:9876 -c /tmp/broker.conf',
            ],
            depends_on: {
              init: { condition: "service_completed_successfully" },
              namesrv: { condition: "service_started" },
            },
            volumes: [
              volume("broker-data", "/home/rocketmq/store"),
              volume("broker-logs", "/home/rocketmq/logs"),
            ],
          },
        },
        [
          port("nameserver", 9876, "namesrv"),
          port("broker", 10911, "broker"),
          port("fast", 10909, "broker"),
          port("ha", 10912, "broker"),
        ],
      );
    },
    (_p, c) => {
      fixedPorts(c, ["nameserver", "broker", "fast", "ha"]);
      if (
        !c.preview &&
        (["broker", "fast", "ha"] as const).some(
          (n) =>
            c.host_ports[n] !== { broker: 10911, fast: 10909, ha: 10912 }[n],
        )
      )
        fail(400, "catalog_rocketmq_fixed_broker_ports");
    },
  ),
];
