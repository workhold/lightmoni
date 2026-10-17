export function listenAddress(raw: string): { host: string; port: number } {
  const matched = /^(?:\[([^\]]+)\]|([^:]*)):(\d+)$/.exec(raw);
  if (!matched)
    throw new Error("invalid LIGHTMONI_ADDR; use host:port or [ipv6]:port");
  const port = Number(matched[3]);
  if (port < 1 || port > 65535) throw new Error("invalid LIGHTMONI_ADDR port");
  return { host: matched[1] || matched[2] || "0.0.0.0", port };
}
