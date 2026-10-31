export type IPAddressCategory = 'public' | 'private' | 'shared' | 'loopback' | 'link_local' | 'special' | 'invalid';
export type NetworkInterfaceRole = 'ordinary' | 'container' | 'tunnel';
export interface NetworkAddressEntry {
  interface: string;
  address: string;
  family: 'IPv4' | 'IPv6';
  scope: string;
}

function ipv4(raw: string): number[] | undefined {
  const parts = raw.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(?:0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255)) return;
  return parts.map(Number);
}

function ipv6(raw: string): number[] | undefined {
  if (!raw.includes(':')) return;
  // Zone identifiers select a local interface; they do not change an IP's range.
  if (raw.includes('%')) {
    const zoned = /^(.+)%[A-Za-z0-9_.~-]{1,64}$/.exec(raw);
    if (!zoned) return;
    raw = zoned[1];
    if (raw.includes('%')) return;
  }
  if (raw.includes('.')) {
    const separator = raw.lastIndexOf(':'), tail = ipv4(raw.slice(separator + 1));
    if (!tail) return;
    raw = raw.slice(0, separator + 1) + ((tail[0] << 8) | tail[1]).toString(16) + ':' + ((tail[2] << 8) | tail[3]).toString(16);
  }
  const halves = raw.split('::');
  if (halves.length > 2) return;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if ([...left, ...right].some(part => !/^[0-9a-f]{1,4}$/i.test(part))) return;
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return;
  return [...left.map(part => parseInt(part, 16)), ...Array(missing).fill(0), ...right.map(part => parseInt(part, 16))];
}

function ipv4Category([a, b, c]: number[]): IPAddressCategory {
  if (a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'shared';
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link_local';
  // Treat special-purpose allocations conservatively, including small global
  // exceptions inside reserved blocks. A range label never proves reachability.
  if (a === 0 || a >= 224 || a === 192 && (b === 0 && (c === 0 || c === 2) || b === 88 && c === 99)
    || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113) return 'special';
  return 'public';
}

export function ipAddressCategory(raw: string): IPAddressCategory {
  const value = raw.trim(), v4 = ipv4(value);
  if (v4) return ipv4Category(v4);
  const v6 = ipv6(value);
  if (!v6) return 'invalid';
  if (v6.slice(0, 5).every(word => word === 0) && v6[5] === 0xffff) return ipv4Category([v6[6] >> 8, v6[6] & 255, v6[7] >> 8, v6[7] & 255]);
  if (v6.slice(0, 7).every(word => word === 0) && v6[7] === 1) return 'loopback';
  if ((v6[0] & 0xfe00) === 0xfc00) return 'private';
  if ((v6[0] & 0xffc0) === 0xfe80) return 'link_local';
  // The display's public range is ordinary global unicast, excluding IANA
  // protocol assignments, documentation and transitional/deprecated blocks.
  // NAT64, multicast and unknown future allocations remain special.
  if ((v6[0] & 0xe000) !== 0x2000 || v6[0] === 0x2001 && ((v6[1] & 0xfe00) === 0 || v6[1] === 0x0db8)
    || v6[0] === 0x2002 || v6[0] === 0x3ffe || v6[0] === 0x3fff && (v6[1] & 0xf000) === 0) return 'special';
  return 'public';
}

export function interfaceRole(name: string): NetworkInterfaceRole {
  const value = name.trim().toLowerCase().replace(/@if[0-9]+$/, '');
  // Names are display hints, not OS device-kind or physical-device evidence.
  if (/^(?:(?:wg|tun|tap|utun)(?:[0-9]+|[._-][a-z0-9_.-]+)|tailscale[0-9]*|zt[a-z0-9]+)$/.test(value)) return 'tunnel';
  if (/^(?:docker0|docker_gwbridge|br-[0-9a-f]{12}|veth[0-9a-f]+|cni[0-9]+|flannel(?:\.[0-9]+)?|cali[0-9a-f]+|virbr[0-9]+|vnet[0-9]+|vmnet[0-9]+)$/.test(value)) return 'container';
  return 'ordinary';
}

export function classifyNetworkAddresses<T extends NetworkAddressEntry>(addresses: T[]): { privateAddresses: T[]; publicAddresses: T[]; tunnelAddresses: T[]; otherAddresses: T[] } {
  const result = { privateAddresses: [] as T[], publicAddresses: [] as T[], tunnelAddresses: [] as T[], otherAddresses: [] as T[] };
  for (const entry of addresses) {
    const role = interfaceRole(entry.interface), category = ipAddressCategory(entry.address);
    if (category === 'loopback' || category === 'link_local' || category === 'special' || category === 'invalid') result.otherAddresses.push(entry);
    else if (role === 'tunnel') result.tunnelAddresses.push(entry);
    else if (role === 'container') result.otherAddresses.push(entry);
    else if (category === 'private' || category === 'shared') result.privateAddresses.push(entry);
    else if (category === 'public') result.publicAddresses.push(entry);
    else result.otherAddresses.push(entry);
  }
  return result;
}

export function sshAddressCategory(raw: string): IPAddressCategory | 'hostname' | 'unconfigured' {
  const value = raw.trim();
  if (!value) return 'unconfigured';
  const bracketed = value.startsWith('[') && value.endsWith(']');
  const literal = bracketed ? value.slice(1, -1) : value;
  if (bracketed && !literal.includes(':')) return 'invalid';
  const category = ipAddressCategory(literal);
  if (category !== 'invalid') return category;
  // Reject ambiguous legacy IPv4 spellings rather than treating them as DNS.
  if (/^[0-9.]+$/.test(value) || /^0x[0-9a-f]+$/i.test(value)) return 'invalid';
  const hostname = value.endsWith('.') ? value.slice(0, -1) : value;
  if (hostname.length > 253 || !hostname || hostname.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return 'invalid';
  return 'hostname';
}
