import { parse, stringify } from "yaml";
import type { Spec } from "./model";
export const yamlText = (value: unknown) =>
  stringify(value, { lineWidth: 0, aliasDuplicateObjects: false });
export function containerYAML(spec: Spec): string {
  const app: Spec = { image: spec.image ?? "nginx:alpine" };
  for (const key of [
    "entrypoint",
    "restart",
    "user",
    "working_dir",
    "read_only",
    "network_mode",
    "networks",
  ])
    if (spec[key] !== undefined) app[key] = spec[key];
  const command = spec.command_rows
    ? spec.command_rows.map((r: Spec) => r.value).filter(Boolean)
    : spec.command;
  if (command?.length) app.command = command;
  const environment = spec.env_rows
    ? Object.fromEntries(
        spec.env_rows
          .filter((r: Spec) => r.key?.trim())
          .map((r: Spec) => [r.key.trim(), r.value ?? ""]),
      )
    : spec.environment;
  if (environment && Object.keys(environment).length)
    app.environment = environment;
  if (spec.network_mode !== "host" && spec.ports?.length)
    app.ports = spec.ports.map((p: Spec) => ({
      target: p.container_port ?? 80,
      published: String(p.host_port ?? 0),
      protocol: p.protocol ?? "tcp",
      host_ip: p.host_ip ?? "0.0.0.0",
    }));
  return yamlText({
    services: { app },
    ...(spec.networks?.length
      ? {
          networks: Object.fromEntries(
            spec.networks.map((name: string) => [
              name,
              { external: true, name },
            ]),
          ),
        }
      : {}),
  });
}
/** Basic fields can represent only the supported single-container document. */
export function containerForm(text: string, previousPorts: Spec[] = []): Spec {
  const doc = parse(text, { maxAliasCount: 20 }),
    app = doc?.services?.app;
  const fields = [
    "image",
    "entrypoint",
    "command",
    "environment",
    "restart",
    "user",
    "working_dir",
    "read_only",
    "network_mode",
    "networks",
    "ports",
  ];
  if (
    !app ||
    Object.keys(doc).some(
      (key) => !["services", "networks", "version"].includes(key),
    ) ||
    Object.keys(doc.services).length !== 1 ||
    Object.keys(app).some((k) => !fields.includes(k))
  )
    throw Error("single_container_yaml_unsupported_field");
  if (
    doc.networks &&
    Object.entries<any>(doc.networks).some(
      ([name, value]) =>
        !Array.isArray(app.networks) ||
        !app.networks.includes(name) ||
        !value ||
        value.external !== true ||
        (value.name !== undefined && value.name !== name),
    )
  )
    throw Error("single_container_yaml_unsupported_field");
  const ports = (app.ports ?? []).map((value: any) => {
    let target: any,
      published: any,
      protocol = "tcp",
      host_ip: any;
    if (typeof value === "number") target = value;
    else if (typeof value === "string") {
      const [binding, p = "tcp"] = value.split("/");
      protocol = p;
      const parts = binding.split(":");
      target = parts.pop();
      published = parts.pop();
      if (parts.length) host_ip = parts.join(":").replace(/^\[|\]$/g, "");
    } else ({ target, published, protocol = "tcp", host_ip } = value);
    const container_port = Number(target),
      host_port = Number(published ?? 0);
    if (
      !Number.isInteger(container_port) ||
      container_port < 1 ||
      container_port > 65535 ||
      !Number.isInteger(host_port) ||
      host_port < 0 ||
      host_port > 65535 ||
      !["tcp", "udp"].includes(protocol)
    )
      throw Error("invalid_yaml_port");
    const old = previousPorts.find(
      (p) =>
        p.container_port === container_port &&
        (p.protocol ?? "tcp") === protocol,
    );
    return {
      name: old?.name ?? `app-${container_port}-${protocol}`,
      container_port,
      host_port,
      protocol,
      host_ip: host_ip ?? old?.host_ip ?? "0.0.0.0",
      app_protocol: old?.app_protocol ?? "",
    };
  });
  const env = Array.isArray(app.environment)
    ? Object.fromEntries(
        app.environment.map((v: string) => {
          const i = v.indexOf("=");
          if (i < 1) throw Error("environment");
          return [v.slice(0, i), v.slice(i + 1)];
        }),
      )
    : (app.environment ?? {});
  return {
    ...Object.fromEntries(
      fields.filter((k) => k !== "ports").map((k) => [k, app[k]]),
    ),
    network_mode: app.network_mode ?? "bridge",
    ports,
    env_rows: Object.entries(env).map(([key, value]) => ({
      key,
      value: String(value),
    })),
    command_rows: (app.command ?? []).map((value: string) => ({ value })),
  };
}
