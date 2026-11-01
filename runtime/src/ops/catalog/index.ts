import { databases } from "./databases.js";
import { middleware } from "./middleware.js";
import { devops } from "./devops.js";
import { ai, dbx } from "./ai.js";
import { harbor } from "./harbor.js";
import { dify } from "./dify.js";
import { fastgpt } from "./fastgpt.js";
import {
  parameters,
  type CatalogDefinition,
  type Input,
  type BuildContext,
} from "./types.js";
import { fail } from "../../shared/http.js";
import { hostPortOverrides } from "../application-ports.js";
export const extendedDefinitions: CatalogDefinition[] = [
  ...databases,
  ...middleware,
  ...devops,
  harbor,
  ...ai,
  dify,
  fastgpt,
  dbx,
];
export const extendedCatalog = extendedDefinitions.map((d) => d.template);
export function extendedInstallation(
  id: string,
  input: Input,
): Input | undefined {
  const def = extendedDefinitions.find((d) => d.template.id === id);
  if (!def) return;
  const p = parameters(def, input.parameters ?? {}),
    mode = input.deployment_mode ?? "manual";
  if (
    !["manual", "managed"].includes(mode) ||
    (def.template.deployment_modes &&
      !def.template.deployment_modes.includes(mode))
  )
    fail(400, "catalog_deployment_mode_unsupported");
  const ports = structuredClone(def.template.spec.ports) as Array<
    Input & { name: string; host_port: number }
  >;
  if (input.deployments !== undefined && !Array.isArray(input.deployments))
    fail(400, "invalid_catalog_parameters");
  const overrides = hostPortOverrides(input.host_ports, ports) ?? {};
  const deploymentPorts = (input.deployments ?? []).map((d: Input) => {
    if (!d || typeof d !== "object" || Array.isArray(d))
      fail(400, "invalid_catalog_parameters");
    return hostPortOverrides(d.host_ports, ports) ?? {};
  });
  const ctx: BuildContext = {
    preview: false,
    deployment_mode: mode,
    host_ports: Object.fromEntries(
      ports.map((v, i) => [
        v.name,
        overrides[v.name] ??
          (i === 0 && p.port !== undefined
            ? p.port
            : mode === "managed"
              ? 0
              : v.container_port),
      ]),
    ),
  };
  // A stable endpoint is part of these recipes, so deployment-level overrides must agree.
  if (
    def.template.deployment_modes?.length === 1 &&
    deploymentPorts.some((overrides: Input) =>
      Object.keys(overrides).some(
        (name) => overrides[name] !== ctx.host_ports[name],
      ),
    )
  )
    fail(400, "catalog_stable_host_ports_required");
  def.validate?.(p, ctx);
  const spec = def.build(p, ctx);
  spec.ports = spec.ports.map((v: Input) => ({
    ...v,
    host_port: ctx.host_ports[v.name],
  }));
  return spec;
}
