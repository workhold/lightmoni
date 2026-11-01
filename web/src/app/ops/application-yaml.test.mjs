import { test } from "node:test";
import assert from "node:assert/strict";
import { containerYAML, containerForm, yamlText } from "./application-yaml.ts";

test("single-container YAML roundtrip preserves commands, masked environments and named mappings", () => {
  const spec = {
    image: "nginx:alpine",
    environment: { TOKEN: "[redacted]" },
    command: ["nginx", "-g", "daemon off;"],
    ports: [
      {
        name: "api",
        container_port: 8080,
        host_port: 0,
        host_ip: "127.0.0.1",
        protocol: "tcp",
        app_protocol: "http",
      },
    ],
  };
  const text = containerYAML(spec);
  assert.match(text, /^services:/);
  assert.doesNotMatch(text, /^\s*\{/);
  const form = containerForm(text, spec.ports);
  assert.deepEqual(form.ports, spec.ports);
  assert.deepEqual(
    form.command_rows.map((v) => v.value),
    spec.command,
  );
  assert.deepEqual(form.env_rows, [{ key: "TOKEN", value: "[redacted]" }]);
  assert.equal(form.image, spec.image);
  assert.match(
    yamlText({ services: { web: { image: "nginx:alpine" } } }),
    /^services:/,
  );
});
test("basic mode refuses to discard unsupported YAML, multiple services or network aliases", () => {
  for (const text of [
    "services: [",
    "services:\n  app:\n    image: nginx:alpine\n  other:\n    image: redis:alpine\n",
    "services:\n  app:\n    image: nginx:alpine\nvolumes:\n  saved: {}\n",
    'services:\n  app:\n    image: nginx:alpine\n    volumes: ["saved:/data"]\n',
    "services:\n  app:\n    image: nginx:alpine\n    networks: [net]\nnetworks:\n  net:\n    external: true\n    name: different\n",
  ])
    assert.throws(() => containerForm(text));
});
