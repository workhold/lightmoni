import { normalizeApplication } from "../operations/platform.js";
import { OperationRejectedError } from "../operations/errors.js";
import { fail } from "../shared/http.js";
type Row = Record<string, any>;
const fields = [
  "image",
  "command",
  "entrypoint",
  "environment",
  "restart",
  "user",
  "working_dir",
  "read_only",
  "network_mode",
  "networks",
];
const numeric = (v: unknown, zero = false) => {
  if (!/^[0-9]+$/.test(String(v))) fail(400, "invalid_yaml_port");
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < (zero ? 0 : 1) || n > 65535)
    fail(400, "invalid_yaml_port");
  return n;
};
function port(value: any, managed: boolean) {
  let target: any,
    published: any,
    host_ip: any,
    protocol = "tcp",
    app_protocol: any;
  if (typeof value === "number") target = value;
  else if (typeof value === "string") {
    const [binding, p = "tcp", extra] = value.split("/");
    if (extra !== undefined) fail(400, "invalid_yaml_port");
    protocol = p;
    const parts = binding.split(":");
    target = parts.pop();
    if (parts.length) published = parts.pop();
    if (parts.length) host_ip = parts.join(":").replace(/^\[|\]$/g, "");
  } else if (value && typeof value === "object" && !Array.isArray(value))
    ({ target, published, host_ip, protocol = "tcp", app_protocol } = value);
  else fail(400, "invalid_yaml_port");
  if (!["tcp", "udp"].includes(protocol)) fail(400, "invalid_yaml_port");
  return {
    container_port: numeric(target),
    host_port:
      managed || published === undefined ? 0 : numeric(published, true),
    host_ip,
    protocol,
    app_protocol,
  };
}
export function stripComposeExtensions(doc: Row) {
  const definitions = [
    doc,
    ...Object.values(doc.services ?? {}),
    ...["networks", "volumes", "secrets", "configs"].flatMap((key) =>
      Object.values(doc[key] ?? {}),
    ),
  ];
  for (const value of definitions)
    if (value && typeof value === "object")
      for (const key of Object.keys(value))
        if (key.startsWith("x-")) delete (value as Row)[key];
}

/** Parse before restoring masked environments; never retain an unredacted source string. */
export function prepareApplicationYAML(input: Row, previous?: Row): Row {
  const s = structuredClone(input),
    advanced = s.configuration_mode === "yaml";
  if (
    s.configuration_mode !== undefined &&
    !["yaml", "form"].includes(s.configuration_mode)
  )
    fail(400, "invalid_application_configuration_mode");
  if (s.mode !== "compose" && !advanced) return s;
  const single = s.mode === "container";
  if (single && typeof s.configuration_yaml !== "string")
    fail(400, "invalid_application_yaml");
  let doc: Row;
  try {
    doc = normalizeApplication({
      mode: "compose",
      compose: single ? s.configuration_yaml : s.compose,
    }).compose;
  } catch (e) {
    if (e instanceof OperationRejectedError) throw e;
    fail(400, "invalid_application_yaml");
  }
  stripComposeExtensions(doc);
  if (single) {
    if (
      Object.keys(doc).some(
        (k) => !["services", "networks", "version"].includes(k),
      ) ||
      Object.keys(doc.services).length !== 1 ||
      !doc.services.app
    )
      fail(400, "single_container_yaml_requires_app");
    const service = doc.services.app;
    if (Object.keys(service).some((k) => ![...fields, "ports"].includes(k)))
      fail(400, "single_container_yaml_unsupported_field");
    for (const key of fields) {
      if (service[key] === undefined) delete s[key];
      else s[key] = service[key];
    }
    if (
      doc.networks &&
      Object.entries<any>(doc.networks).some(
        ([name, v]) =>
          !Array.isArray(s.networks) ||
          !s.networks.includes(name) ||
          !v ||
          v.external !== true ||
          (v.name !== undefined && v.name !== name),
      )
    )
      fail(400, "single_container_yaml_unsupported_field");
  } else s.compose = doc;
  if (advanced) {
    const managed = s.deployment_mode === "managed",
      first = Object.keys(doc.services)[0],
      declared: Row[] = [];
    const candidates = [...(s.ports ?? []), ...(previous?.ports ?? [])];
    for (const [name, service] of Object.entries<Row>(doc.services)) {
      if (service.ports !== undefined && !Array.isArray(service.ports))
        fail(400, "invalid_yaml_port");
      for (const raw of service.ports ?? []) {
        const p = port(raw, managed),
          old = candidates.find(
            (v) =>
              (v.service ?? (single ? "app" : first)) === name &&
              v.container_port === p.container_port &&
              (v.protocol ?? "tcp") === p.protocol,
          );
        // Saving a generated document must preserve an existing automatic mapping.
        const prior = (previous?.compose?.services?.[name]?.ports ?? [])
          .map((v: any) => port(v, false))
          .find(
            (v: Row) =>
              v.container_port === p.container_port &&
              v.protocol === p.protocol,
          );
        const sameAutomatic =
          old?.host_port === 0 && prior?.host_port === p.host_port;
        declared.push({
          name:
            old?.name ??
            name
              .toLowerCase()
              .replace(/[^a-z0-9-]/g, "-")
              .slice(0, 44) +
              "-" +
              p.container_port +
              "-" +
              p.protocol,
          container_port: p.container_port,
          host_port: managed || sameAutomatic ? 0 : p.host_port,
          protocol: p.protocol,
          host_ip: managed
            ? (old?.host_ip ?? p.host_ip ?? "0.0.0.0")
            : (p.host_ip ?? old?.host_ip ?? "0.0.0.0"),
          app_protocol: old?.app_protocol ?? p.app_protocol ?? "",
          ...(!single ? { service: name } : {}),
        });
      }
    }
    if (s.role === "openresty") {
      if (!single || declared.length)
        fail(400, "openresty_requires_standard_ports");
      s.ports = previous?.ports ?? s.ports;
    } else s.ports = declared;
  }
  delete s.configuration_yaml;
  return s;
}
