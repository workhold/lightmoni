/** Validates the actual Agent renderer without pulling images or starting services. */
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { extendedDefinitions } from "../../src/ops/catalog/index.js";
import { catalogInstallation } from "../../src/ops/catalog.js";
import {
  normalizeApplication,
  renderManifest,
} from "../../src/operations/platform.js";
const root = await realpath(
    await mkdtemp(join(tmpdir(), "lightmoni-catalog-config-")),
  ),
  checks: any[] = [];
const context: any = {
  dataDir: root,
  signal: new AbortController().signal,
  now: () => new Date(),
};
try {
  for (const { template } of extendedDefinitions) {
    const parameters = Object.fromEntries(
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
    const spec = catalogInstallation(template.id, { parameters }).spec;
    for (const [name, service] of Object.entries<any>(spec.compose.services))
      service.ports = spec.ports
        .filter((p: any) => p.service === name)
        .map((p: any) => ({
          target: p.container_port,
          published: String(p.host_port),
          protocol: p.protocol,
          host_ip: p.host_ip,
        }));
    const manifest = await renderManifest(
        context,
        "catalog-" + template.id,
        normalizeApplication(spec),
        1,
      ),
      path = join(root, template.id + ".json");
    await writeFile(path, JSON.stringify(manifest), { mode: 0o600 });
    try {
      execFileSync(
        "docker",
        [
          "compose",
          "--project-name",
          "lm-catalog-" + template.id,
          "-f",
          path,
          "config",
          "--quiet",
        ],
        { stdio: "pipe", timeout: 15000 },
      );
      checks.push({
        id: template.id,
        services: Object.keys(manifest.services).length,
        result: "passed",
      });
    } catch (error: any) {
      throw Error(template.id + ":" + error.stderr?.toString());
    }
  }
  const out = resolve(
    import.meta.dirname,
    "../../../specs/066-app-catalog-expansion/evidence",
  );
  await mkdir(out, { recursive: true });
  await writeFile(
    join(out, "compose.json"),
    JSON.stringify(
      { checks, images_pulled: false, containers_started: false },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({
      recipes: checks.length,
      services: checks.reduce((n, c) => n + c.services, 0),
      result: "passed",
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
