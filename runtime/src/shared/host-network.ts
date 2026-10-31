import { isIP } from "node:net";

export const MAX_NETWORK_ADDRESSES = 64;
export type NetworkScope = "private" | "public" | "link_local" | "loopback";
export interface HostNetworkAddress {
  interface: string;
  address: string;
  family: "IPv4" | "IPv6";
  scope: NetworkScope;
}

/** No ports, brackets or zone identifiers are accepted as an IP address. */
export function normalizeIPAddress(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || value.includes("%")) return "";
  const address = value.trim(), family = isIP(address);
  if (!family) return "";
  return family === 4 ? address : new URL(`http://[${address}]/`).hostname.slice(1, -1);
}

function mappedIPv4(address: string): string {
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (!match) return address;
  const high = parseInt(match[1], 16), low = parseInt(match[2], 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

export function networkScope(address: string): NetworkScope {
  const ip = mappedIPv4(normalizeIPAddress(address)), family = isIP(ip);
  if (family === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 127) return "loopback";
    if (a === 169 && b === 254) return "link_local";
    if (a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127) return "private";
  } else if (family === 6) {
    if (ip === "::1") return "loopback";
    const first = parseInt(ip.split(":")[0] || "0", 16);
    if ((first & 0xffc0) === 0xfe80) return "link_local";
    if ((first & 0xfe00) === 0xfc00) return "private";
  }
  // "public" describes the address scope, not a claim of external reachability.
  return "public";
}

export function usableNetworkAddress(address: string): boolean {
  const ip = mappedIPv4(address), family = isIP(ip);
  if (family === 4) {
    const first = Number(ip.split(".")[0]);
    return first !== 0 && first < 224 && ip !== "255.255.255.255";
  }
  return family === 6 && ip !== "::" && !ip.startsWith("ff");
}

/** Server derives family/scope; Agent supplied labels cannot change them. */
export function normalizeNetworkAddresses(value: unknown): HostNetworkAddress[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_NETWORK_ADDRESSES) throw Error("invalid network_addresses");
  const unique = new Map<string, HostNetworkAddress>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || typeof entry.interface !== "string" || !entry.interface.trim()
      || Buffer.byteLength(entry.interface) > 128 || /[\u0000-\u001f\u007f-\u009f]/.test(entry.interface)) throw Error("invalid network interface");
    const address = normalizeIPAddress(entry.address);
    if (!address || !usableNetworkAddress(address)) throw Error("invalid network address");
    const family = isIP(address) === 4 ? "IPv4" : "IPv6";
    if (entry.family !== undefined && entry.family !== family) throw Error("invalid network address family");
    const item: HostNetworkAddress = { interface: entry.interface.trim(), address, family, scope: networkScope(address) };
    unique.set(item.interface + "\0" + item.address, item);
  }
  return [...unique.values()].sort((a, b) => a.interface.localeCompare(b.interface) || a.address.localeCompare(b.address));
}
