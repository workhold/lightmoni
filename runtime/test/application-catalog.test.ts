import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applicationCatalog,
  applicationCategories,
  catalogInstallation,
} from "../src/ops/catalog.js";
const additions = [
  "postgresql",
  "mariadb",
  "mongodb",
  "clickhouse",
  "elasticsearch",
  "qdrant",
  "influxdb",
  "rabbitmq",
  "nacos",
  "emqx",
  "memcached",
  "kafka",
  "rocketmq",
  "gitea",
  "jenkins",
  "gitlab",
  "harbor",
  "nexus",
  "sonarqube",
  "ollama",
  "openwebui",
  "maxkb",
  "anythingllm",
  "dify",
  "fastgpt",
  "vllm",
  "dbx",
  "meilisearch",
  "searxng",
  "firecrawl",
  "rustfs",
];
test('Gitea defaults to a dedicated host SSH port and advertises explicit overrides',()=>{
 const parameters={external_url:'https://git.example.test'};
 const template=applicationCatalog.find(t=>t.id==='gitea')!;
 assert.equal(template.spec.ports.find((p:any)=>p.name==='ssh').host_port,2222);
 const spec=catalogInstallation('gitea',{parameters}).spec;
 assert.equal(spec.ports.find((p:any)=>p.name==='ssh').container_port,22);
 assert.equal(spec.ports.find((p:any)=>p.name==='ssh').host_port,2222);
 assert.equal(spec.compose.services.gitea.environment.GITEA__server__SSH_PORT,'2222');
 const custom=catalogInstallation('gitea',{parameters,host_ports:{http:13000,ssh:12222}}).spec;
 assert.equal(custom.ports.find((p:any)=>p.name==='ssh').host_port,12222);
 assert.equal(custom.compose.services.gitea.environment.GITEA__server__SSH_PORT,'12222');
 assert.throws(()=>catalogInstallation('gitea',{parameters,host_ports:{ssh:0}}),/catalog_fixed_host_port_required/);
});
test("catalog covers the approved scope and categories include search and cloud storage", () => {
  assert.equal(applicationCatalog.length, 35);
  assert.equal(new Set(applicationCatalog.map((t) => t.id)).size, 35);
  for (const id of additions)
    assert.ok(
      applicationCatalog.some((t) => t.id === id),
      id,
    );
  assert.deepEqual(
    applicationCatalog.filter((t) => t.category === "tools").map((t) => t.id),
    ["dbx", "firecrawl"],
  );
  assert.deepEqual(
    applicationCategories.map((c) => c.id),
    ["database", "middleware", "devops", "ai", "tools", "web", "search", "storage"],
  );
  assert.equal(
    applicationCategories.reduce((sum, c) => sum + c.count, 0),
    35,
  );
});
test("DBX requires a password and keeps it out of commands and managed files", () => {
  assert.throws(
    () => catalogInstallation("dbx", {}),
    /catalog_parameter_required/,
  );
  const spec = catalogInstallation("dbx", {
    parameters: { password: 'qa-secret-$_"long' },
    host_ports: { http: 14224 },
    listen_ip: "127.0.0.1",
  }).spec;
  assert.equal(
    spec.compose.services.dbx.environment.DBX_PASSWORD,
    'qa-secret-$_"long',
  );
  assert.equal(spec.ports[0].host_port, 14224);
  assert.equal(spec.ports[0].container_port, 4224);
  assert.equal(spec.ports[0].host_ip, "127.0.0.1");
  const safe = structuredClone(spec);
  delete safe.compose.services.dbx.environment;
  assert.doesNotMatch(JSON.stringify(safe), /qa-secret/);
  assert.ok(
    spec.compose.services.dbx.volumes.some(
      (v: any) => v.target === "/app/data",
    ),
  );
  assert.throws(
    () => catalogInstallation("dbx", { parameters: { password: 123 } }),
    /invalid_catalog_parameter/,
  );
  assert.throws(
    () =>
      catalogInstallation("dbx", {
        parameters: { password: "valid", unknown: "value" },
      }),
    /invalid_catalog_parameter/,
  );
});
import { extendedDefinitions } from "../src/ops/catalog/index.js";
import { normalizeApplication } from "../src/operations/platform.js";
import { workloadContainersReady } from "../src/operations/workload-readiness.js";
export function catalogSample(id: string) {
  const template = applicationCatalog.find((t) => t.id === id)!;
  return Object.fromEntries(
    template.parameters
      .filter((p) => p.required || p.default !== undefined)
      .map((p) => [
        p.key,
        p.default ??
          p.example ??
          (p.type === "password"
            ? "qa_secret_2026_long"
            : p.format === "url"
              ? "http://app.example.test"
              : p.format === "ip"
                ? "192.0.2.10"
                : p.format === "host"
                  ? "broker.example.test"
                  : "app"),
      ]),
  );
}
test("every new recipe normalizes, uses pinned images and isolated volumes, and keeps credentials exclusively in environments", () => {
  for (const { template } of extendedDefinitions) {
    const before = JSON.stringify(template),
      parameters = catalogSample(template.id),
      spec = catalogInstallation(template.id, { parameters }).spec;
    assert.equal(
      JSON.stringify(template),
      before,
      template.id + " mutated public catalog",
    );
    const normalized = normalizeApplication(spec);
    assert.ok(Object.keys(normalized.compose.services).length > 0, template.id);
    for (const [name, service] of Object.entries<any>(spec.compose.services)) {
      assert.match(service.image, /(?:@sha256:[a-f0-9]{64}|:[^/]+)$/);
      assert.doesNotMatch(service.image, /:latest$/);
      assert.equal(service.privileged, undefined);
      assert.equal(service.container_name, undefined);
      assert.equal(service.env_file, undefined);
      for (const mount of service.volumes ?? []) {
        assert.equal(mount.type, "volume");
        assert.ok(spec.compose.volumes[mount.source]);
        assert.equal(spec.compose.volumes[mount.source].external, undefined);
        assert.equal(spec.compose.volumes[mount.source].name, undefined);
      }
      for (const dependency of Array.isArray(service.depends_on)
        ? service.depends_on
        : Object.keys(service.depends_on ?? {}))
        assert.ok(
          spec.compose.services[dependency],
          template.id + ":" + name + ":" + dependency,
        );
    }
    const visible = structuredClone(spec);
    for (const service of Object.values<any>(visible.compose.services))
      delete service.environment;
    assert.doesNotMatch(
      JSON.stringify(visible),
      /qa_secret_2026_long|docker\.sock|\[generated:|\[secret:/,
      template.id,
    );
    for (const p of template.parameters.filter(
      (p) => p.required && p.default === undefined,
    )) {
      const bad = { ...parameters };
      delete bad[p.key];
      assert.throws(
        () => catalogInstallation(template.id, { parameters: bad }),
        /catalog_parameter_required/,
        template.id + ":" + p.key,
      );
    }
  }
});
test("typed fields, URLs, versions and stable endpoint mappings reject bad requests before creating resources", () => {
  assert.throws(
    () => catalogInstallation("memcached", { parameters: { cache_mb: "64" } }),
    /invalid_catalog_parameter/,
  );
  assert.throws(
    () => catalogInstallation("memcached", { parameters: { cache_mb: 1 } }),
    /invalid_catalog_parameter/,
  );
  assert.throws(
    () =>
      catalogInstallation("dify", {
        parameters: { external_url: "http://user:pass@example.test" },
      }),
    /invalid_catalog_parameter/,
  );
  assert.throws(
    () =>
      catalogInstallation("dify", {
        parameters: { external_url: "file:///etc/passwd" },
      }),
    /invalid_catalog_parameter/,
  );
  assert.throws(
    () =>
      catalogInstallation("dify", {
        parameters: { external_url: "https://example.test/prefix" },
      }),
    /invalid_catalog_parameter/,
  );
  assert.throws(
    () =>
      catalogInstallation("dbx", {
        version: "latest",
        parameters: { password: "qa_secret_2026_long" },
      }),
    /unsupported_template_version/,
  );
  assert.throws(
    () =>
      catalogInstallation("vllm", {
        deployment_mode: "managed",
        parameters: catalogSample("vllm"),
      }),
    /catalog_deployment_mode_unsupported/,
  );
  assert.throws(
    () =>
      catalogInstallation("nacos", {
        host_ports: { http: 18848, grpc: 19847 },
      }),
    /catalog_nacos_grpc_port_offset/,
  );
  assert.throws(
    () => catalogInstallation("nacos", { host_ports: { http: 0, grpc: 0 } }),
    /catalog_fixed_host_port_required/,
  );
  const nacos = catalogInstallation("nacos", {
    host_ports: { http: 18848, grpc: 19848 },
  }).spec;
  assert.equal(nacos.ports[1].host_port, 19848);
  assert.throws(
    () =>
      catalogInstallation("rocketmq", {
        parameters: catalogSample("rocketmq"),
        host_ports: { broker: 32000 },
      }),
    /catalog_rocketmq_fixed_broker_ports/,
  );
  const kafka = catalogInstallation("kafka", {
    parameters: catalogSample("kafka"),
    host_ports: { kafka: 39094 },
  }).spec;
  assert.match(
    kafka.compose.services.kafka.environment.KAFKA_ADVERTISED_LISTENERS,
    /EXTERNAL:\/\/broker.example.test:39094$/,
  );
  assert.throws(
    () =>
      catalogInstallation("kafka", {
        parameters: catalogSample("kafka"),
        host_ports: { kafka: 0 },
      }),
    /catalog_fixed_host_port_required/,
  );
  assert.throws(
    () =>
      catalogInstallation("kafka", {
        parameters: catalogSample("kafka"),
        deployments: [{ host_ports: { kafka: 9095 } }],
      }),
    /catalog_stable_host_ports_required/,
  );
});
test("reserved database identity, bucket isolation, deployment shapes and Jenkins bootstrap stay valid", () => {
  assert.throws(
    () =>
      catalogInstallation("mariadb", {
        parameters: { ...catalogSample("mariadb"), user: "root" },
      }),
    /invalid_catalog_parameter/,
  );
  assert.throws(
    () =>
      catalogInstallation("fastgpt", {
        parameters: {
          ...catalogSample("fastgpt"),
          public_bucket: "same-bucket",
          private_bucket: "same-bucket",
        },
      }),
    /catalog_bucket_names_must_differ/,
  );
  assert.throws(
    () =>
      catalogInstallation("dbx", {
        parameters: catalogSample("dbx"),
        deployments: [null],
      }),
    /invalid_catalog_parameters/,
  );
  const j = catalogInstallation("jenkins", {
    parameters: catalogSample("jenkins"),
  }).spec.compose.services.jenkins;
  assert.ok(j.environment.JENKINS_BOOTSTRAP_GROOVY.includes("\n"));
  assert.match(
    j.environment.JENKINS_BOOTSTRAP_GROOVY,
    /if \(!marker.exists\(\)\)/,
  );
  assert.ok(j.entrypoint[2].includes('"$JENKINS_BOOTSTRAP_GROOVY"'));
  const a = catalogInstallation("kafka", { parameters: catalogSample("kafka") })
    .spec.compose.services.kafka.environment;
  const b = catalogInstallation("kafka", { parameters: catalogSample("kafka") })
    .spec.compose.services.kafka.environment;
  assert.match(a.CLUSTER_ID, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(a.CLUSTER_ID, b.CLUSTER_ID);
});

test("one-shot readiness requires the authorized manifest, normal exit zero, all services, and healthy running daemons", () => {
  const services = {
    init: { labels: { "io.lightmoni.platform.oneshot": "true" } },
    web: {},
  };
  const container = (name: string, state: any, init = false) => ({
    Config: {
      Labels: {
        "com.docker.compose.service": name,
        ...(init ? { "io.lightmoni.platform.oneshot": "true" } : {}),
      },
    },
    State: state,
  });
  const init = container(
      "init",
      { Status: "exited", Running: false, ExitCode: 0 },
      true,
    ),
    web = container("web", {
      Status: "running",
      Running: true,
      Health: { Status: "healthy" },
    });
  assert.equal(workloadContainersReady([init, web], 2, services), true);
  for (const state of [
    { Status: "running", Running: true },
    { Status: "exited", Running: false, ExitCode: 1 },
    { Status: "exited", Running: false, ExitCode: 0, OOMKilled: true },
  ])
    assert.equal(
      workloadContainersReady([{ ...init, State: state }, web], 2, services),
      false,
    );
  assert.equal(
    workloadContainersReady([init, web], 2, { init: {}, web: {} }),
    false,
  );
  assert.equal(workloadContainersReady([init], 2, services), false);
  assert.equal(
    workloadContainersReady(
      [
        init,
        { ...web, State: { Running: true, Health: { Status: "unhealthy" } } },
      ],
      2,
      services,
    ),
    false,
  );
  assert.equal(
    workloadContainersReady([init, web], 2, { ...services, missing: {} }),
    false,
  );
});
test("GPU, storage, authentication, sandbox and bootstrap contracts are explicit", () => {
  const spec = (id: string) =>
    catalogInstallation(id, { parameters: catalogSample(id) }).spec;
  assert.deepEqual(
    spec("vllm").compose.services.vllm.deploy.resources.reservations.devices,
    [{ driver: "nvidia", count: 1, capabilities: ["gpu"] }],
  );
  assert.equal(spec("memcached").stateful, false);
  assert.equal(spec("memcached").ports[0].host_ip, "127.0.0.1");
  assert.equal(spec("ollama").ports[0].host_ip, "127.0.0.1");
  const dify = spec("dify");
  assert.equal(
    dify.compose.services.api.environment.SECRET_KEY,
    dify.compose.services.worker.environment.SECRET_KEY,
  );
  assert.equal(dify.compose.services.api.environment.STORAGE_TYPE, "opendal");
  assert.deepEqual(dify.compose.services.sandbox.networks, ["sandbox-net"]);
  assert.equal(dify.compose.networks["sandbox-net"].internal, true);
  const fastgpt = spec("fastgpt");
  assert.equal(
    fastgpt.compose.services.app.environment.AGENT_SANDBOX_PROVIDER,
    "",
  );
  assert.equal(
    fastgpt.compose.services.app.environment.STORAGE_VENDOR,
    "aws-s3",
  );
  assert.equal(
    fastgpt.compose.services.init.labels["io.lightmoni.platform.oneshot"],
    "true",
  );
  assert.notEqual(
    spec("postgresql").compose.services.postgres.environment.POSTGRES_PASSWORD,
    undefined,
  );
  assert.match(
    spec("rocketmq").compose.services.broker.command.join(" "),
    /LocalAuthenticationMetadataProvider/,
  );
  assert.deepEqual(
    applicationCatalog.find((t) => t.id === "harbor")!.architectures,
    ["amd64"],
  );
});

test("search and cloud storage recipes enforce credentials and independent endpoint mappings", () => {
  assert.deepEqual(applicationCatalog.filter(t => t.category === "search").map(t => t.id), ["meilisearch", "searxng"]);
  assert.deepEqual(applicationCatalog.filter(t => t.category === "storage").map(t => t.id), ["rustfs"]);
  assert.throws(() => catalogInstallation("meilisearch", { parameters: { master_key: "short-key" } }), /invalid_catalog_parameter/);
  const meili = catalogInstallation("meilisearch", { parameters: { master_key: 'literal-$_"-master-key' } }).spec;
  assert.equal(meili.compose.services.meilisearch.environment.MEILI_MASTER_KEY, 'literal-$_"-master-key');
  assert.equal(meili.compose.services.meilisearch.environment.MEILI_ENV, "production");
  const rust = catalogInstallation("rustfs", { parameters: { access_key: "storage-admin", secret_key: 'literal-$_"-secret' }, host_ports: { s3: 19000, console: 19001 } }).spec;
  assert.deepEqual(rust.ports.map((p: any) => [p.name, p.container_port, p.host_port]), [["s3", 9000, 19000], ["console", 9001, 19001]]);
  assert.equal(rust.compose.services.rustfs.environment.RUSTFS_SECRET_KEY, 'literal-$_"-secret');
  assert.equal(rust.stateful, true);
  assert.throws(() => catalogInstallation("rustfs", { parameters: { access_key: "a/b", secret_key: "valid-secret" } }), /invalid_catalog_parameter/);
  assert.throws(() => catalogInstallation("rustfs", { parameters: { access_key: "admin", secret_key: "short" } }), /invalid_catalog_parameter/);
  assert.throws(() => catalogInstallation("rustfs", { parameters: { access_key: "rustfsadmin", secret_key: "custom-secret" } }), /invalid_catalog_parameter/);
  assert.throws(() => catalogInstallation("rustfs", { parameters: { access_key: "custom-admin", secret_key: "rustfsadmin" } }), /invalid_catalog_parameter/);
  for (const id of ["meilisearch", "rustfs"]) assert.throws(() => catalogInstallation(id, {}), /catalog_parameter_required/);
});

test("SearXNG and Firecrawl isolate their services, generate fresh secrets and default to loopback", () => {
  const searx = catalogInstallation("searxng", {}).spec;
  assert.equal(searx.ports[0].host_ip, "127.0.0.1");
  assert.match(searx.compose.services.searxng.entrypoint[2], /formats: \[html, json\]/);
  assert.notEqual(searx.compose.services.searxng.environment.SEARXNG_SECRET, catalogInstallation("searxng", {}).spec.compose.services.searxng.environment.SEARXNG_SECRET);
  const fire = catalogInstallation("firecrawl", { parameters: { searxng_endpoint: "http://searxng.example.test/" }, host_ports: { http: 13002 } }).spec;
  assert.deepEqual(Object.keys(fire.compose.services).sort(), ["api", "nuq-postgres", "playwright", "rabbitmq", "redis"]);
  assert.equal(fire.ports.length, 1);
  assert.equal(fire.ports[0].host_ip, "127.0.0.1");
  assert.equal(fire.ports[0].host_port, 13002);
  const env = fire.compose.services.api.environment;
  assert.equal(env.SEARXNG_ENDPOINT, "http://searxng.example.test/search");
  assert.equal(env.POSTGRES_PASSWORD, fire.compose.services["nuq-postgres"].environment.POSTGRES_PASSWORD);
  assert.equal(new URL(env.REDIS_URL).password, fire.compose.services.redis.environment.REDIS_PASSWORD);
  assert.equal(new URL(env.NUQ_RABBITMQ_URL).password, fire.compose.services.rabbitmq.environment.RABBITMQ_DEFAULT_PASS);
  assert.equal(fire.compose.services["nuq-postgres"].environment.POSTGRES_DB, "postgres");
  const again = catalogInstallation("firecrawl", {}).spec;
  assert.equal(again.compose.services.api.environment.SEARXNG_ENDPOINT, undefined);
  assert.notEqual(env.POSTGRES_PASSWORD, again.compose.services.api.environment.POSTGRES_PASSWORD);
  assert.throws(() => catalogInstallation("firecrawl", { parameters: { searxng_endpoint: "http://user:secret@example.test" } }), /invalid_catalog_parameter/);
  assert.throws(() => catalogInstallation("firecrawl", { parameters: { searxng_endpoint: "https://example.test/search" } }), /invalid_catalog_parameter/);
  assert.equal(catalogInstallation("firecrawl", { listen_ip: "0.0.0.0" }).spec.ports[0].host_ip, "0.0.0.0");
});
