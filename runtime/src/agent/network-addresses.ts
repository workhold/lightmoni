import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { MAX_NETWORK_ADDRESSES, normalizeIPAddress, normalizeNetworkAddresses, usableNetworkAddress, type HostNetworkAddress } from "../shared/host-network.js";

/** Local inspection only: no outbound request to a third-party IP service. */
export function collectNetworkAddresses(interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>): HostNetworkAddress[] | undefined {
  // An unavailable OS snapshot must not clear the last known inventory.
  if (interfaces === undefined) {
    try { interfaces = networkInterfaces(); } catch { return undefined; }
  }
  const values: { interface: string; address: string }[] = [];
  for (const name of Object.keys(interfaces).sort()) {
    if (!name.trim() || Buffer.byteLength(name) > 128 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) continue;
    for (const entry of interfaces[name] ?? []) {
      const address = normalizeIPAddress(entry.address);
      if (address && usableNetworkAddress(address)) values.push({ interface: name, address });
    }
  }
  // Normalize/deduplicate before applying the wire bound, so repeated entries
  // cannot crowd all other interfaces out of the heartbeat.
  const unique = [...new Map(values.map(value => [value.interface + "\0" + value.address, value])).values()];
  return normalizeNetworkAddresses(unique.slice(0, MAX_NETWORK_ADDRESSES))!;
}
