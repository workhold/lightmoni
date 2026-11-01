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
];
test("catalog covers the approved scope and tools only contain DBX", () => {
  assert.equal(applicationCatalog.length, 31);
  assert.equal(new Set(applicationCatalog.map((t) => t.id)).size, 31);
  for (const id of additions)
    assert.ok(
      applicationCatalog.some((t) => t.id === id),
      id,
    );
  assert.deepEqual(
    applicationCatalog.filter((t) => t.category === "tools").map((t) => t.id),
    ["dbx"],
  );
  assert.deepEqual(
    applicationCategories.map((c) => c.id),
    ["database", "middleware", "devops", "ai", "tools", "web"],
  );
  assert.equal(
    applicationCategories.reduce((sum, c) => sum + c.count, 0),
    31,
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
            ? "qa_secret_2026"
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
      /qa_secret_2026|docker\.sock|\[generated:|\[secret:/,
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
        parameters: { password: "qa_secret_2026" },
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
