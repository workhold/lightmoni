import { compose, define, depends, health, port, redis, secret, volume } from "./types.js";

// Official multi-architecture manifests, resolved 2026-11-04.
const playwrightImage = "ghcr.io/firecrawl/playwright-service@sha256:637fb8c8399634b02c2179da72566ce11644435e5d93e895bdbde4b1f9b0882a";
const nuqImage = "ghcr.io/firecrawl/nuq-postgres@sha256:d719b36160eac2fcbe16dc7e7360ddb9c82c40ea5da183d07bf4a755c6a0b2ae";

export const firecrawl = define(
  {
    id: "firecrawl",
    name: "Firecrawl",
    description: "将网页抓取为 Markdown 和结构化数据的自托管 API。",
    description_en: "Self-hosted API for turning web pages into Markdown and structured data.",
    category: "tools",
    architectures: ["amd64", "arm64"],
    version: "2.10.19",
    homepage: "https://docs.firecrawl.dev/contributing/self-host",
    resources: { cpu: 2, memory_mb: 2048 },
    notes: "包含 API / Worker、Playwright、Redis、RabbitMQ 和 NuQ PostgreSQL，共五个服务，资源按每容器设置。自托管 API 不含账号鉴权，默认仅本机监听；对外开放须配置网关认证。基础抓取无需模型；云端反爬与部分高级功能不包含在内。可选连接已安装的 SearXNG 以提供搜索。",
    notes_en: "Five services: API / workers, Playwright, Redis, RabbitMQ and NuQ PostgreSQL. Resource limits apply per container. The self-hosted API has no account authentication and binds to localhost by default; add gateway authentication for public access. Basic scraping needs no model. Cloud anti-bot and some advanced features are unavailable. Optionally connect an existing SearXNG instance for search.",
    parameters: [{
      key: "searxng_endpoint", label: "SearXNG 地址（可选）", label_en: "SearXNG URL (optional)", type: "string", format: "url", max: 512,
      description: "填写容器可访问的 HTTP(S) 源地址，不含 /search；留空不启用搜索。",
      description_en: "Container-accessible HTTP(S) origin without /search. Leave empty to disable search.",
    }],
  },
  (p, c) => {
    const redisPassword = secret(c), pgPassword = secret(c), rabbitPassword = secret(c);
    return compose({
      api: {
        image: "ghcr.io/firecrawl/firecrawl:2.10.19",
        command: ["node", "dist/src/harness.js", "--start-docker"],
        environment: {
          HOST: "0.0.0.0", PORT: "3002", ENV: "local",
          EXTRACT_WORKER_PORT: "3004", WORKER_PORT: "3005",
          USE_DB_AUTHENTICATION: "false",
          REDIS_URL: `redis://:${redisPassword}@redis:6379`,
          REDIS_RATE_LIMIT_URL: `redis://:${redisPassword}@redis:6379`,
          PLAYWRIGHT_MICROSERVICE_URL: "http://playwright:3000/scrape",
          POSTGRES_USER: "postgres", POSTGRES_PASSWORD: pgPassword,
          POSTGRES_DB: "postgres", POSTGRES_HOST: "nuq-postgres", POSTGRES_PORT: "5432",
          NUQ_RABBITMQ_URL: `amqp://firecrawl:${rabbitPassword}@rabbitmq:5672`,
          BULL_AUTH_KEY: secret(c),
          NUM_WORKERS_PER_QUEUE: "2", CRAWL_CONCURRENT_REQUESTS: "2", MAX_CONCURRENT_JOBS: "2", BROWSER_POOL_SIZE: "2",
          ...(p.searxng_endpoint ? { SEARXNG_ENDPOINT: p.searxng_endpoint.replace(/\/$/, "") + "/search" } : {}),
        },
        depends_on: depends("redis", "rabbitmq", "nuq-postgres", "playwright"),
        healthcheck: health(["CMD", "node", "-e", "fetch('http://127.0.0.1:3002/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"], "60s"),
      },
      playwright: {
        image: playwrightImage,
        environment: { PORT: "3000", MAX_CONCURRENT_PAGES: "2", BLOCK_MEDIA: "true" },
        healthcheck: health(["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"], "30s"),
      },
      redis: redis(redisPassword),
      rabbitmq: {
        image: "rabbitmq:4.2.1-alpine",
        hostname: "rabbitmq",
        environment: { RABBITMQ_DEFAULT_USER: "firecrawl", RABBITMQ_DEFAULT_PASS: rabbitPassword },
        volumes: [volume("rabbitmq-data", "/var/lib/rabbitmq")],
        healthcheck: health(["CMD", "rabbitmq-diagnostics", "-q", "check_running"], "30s"),
      },
      "nuq-postgres": {
        image: nuqImage,
        environment: { POSTGRES_USER: "postgres", POSTGRES_PASSWORD: pgPassword, POSTGRES_DB: "postgres" },
        volumes: [volume("nuq-data", "/var/lib/postgresql/data")],
        healthcheck: health(["CMD", "pg_isready", "-U", "postgres", "-d", "postgres"]),
      },
    }, [{ ...port("http", 3002, "api", "http"), host_ip: "127.0.0.1" }]);
  },
);
