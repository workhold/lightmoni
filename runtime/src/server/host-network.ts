import { BlockList, isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import type { DB } from "../shared/sqlite.js";
import { normalizeIPAddress, normalizeNetworkAddresses, type HostNetworkAddress } from "../shared/host-network.js";

export type SourceKind = "direct" | "trusted_proxy" | "unavailable";
export interface NetworkSource { source_ip: string; source_kind: SourceKind }
export interface MachineNetwork {
  addresses: HostNetworkAddress[];
  private_ips: string[];
  public_ips: string[];
  observed_at: string;
  source_ip: string;
  source_observed_at: string;
  source_kind: SourceKind;
}

export function createHostNetworkSchema(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS machine_network_observations(
    machine_id TEXT PRIMARY KEY REFERENCES managed_machines(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    addresses_json TEXT NOT NULL DEFAULT '[]',
    observed_at TEXT NOT NULL DEFAULT '',
    source_ip TEXT NOT NULL DEFAULT '',
    source_observed_at TEXT NOT NULL DEFAULT '',
    source_kind TEXT NOT NULL DEFAULT 'unavailable'
  )`);
}

export function trustedProxyMatcher(ranges: string[] = []): (address: string) => boolean {
  const block = new BlockList();
  for (const range of ranges) {
    if (typeof range !== "string") throw Error("invalid LIGHTMONI_TRUSTED_PROXIES");
    const parts = range.trim().split("/"), address = normalizeIPAddress(parts[0]), family = isIP(address);
    if (!address || parts.length > 2 || parts.length === 2 && (!/^\d+$/.test(parts[1]) || Number(parts[1]) > (family === 4 ? 32 : 128))) throw Error("invalid LIGHTMONI_TRUSTED_PROXIES");
    if (parts.length === 2) block.addSubnet(address, Number(parts[1]), family === 4 ? "ipv4" : "ipv6");
    else block.addAddress(address, family === 4 ? "ipv4" : "ipv6");
  }
  return address => {
    const normalized = normalizeIPAddress(address), family = isIP(normalized);
    return !!family && block.check(normalized, family === 4 ? "ipv4" : "ipv6");
  };
}

/** Forwarded headers are effective only behind an explicitly trusted peer. */
export function observeNetworkSource(req: IncomingMessage, trusted: (address: string) => boolean): NetworkSource {
  const peer = normalizeIPAddress(req.socket?.remoteAddress);
  const unavailable: NetworkSource = { source_ip: "", source_kind: "unavailable" };
  if (!peer) return unavailable;
  if (!trusted(peer)) return { source_ip: peer, source_kind: "direct" };
  const header = req.headers["x-forwarded-for"];
  if (typeof header !== "string" || header.length > 4096) return unavailable;
  const entries = header.split(",");
  if (!entries.length || entries.length > 32) return unavailable;
  const chain = entries.map(normalizeIPAddress);
  if (chain.some(address => !address)) return unavailable;
  let source = peer;
  for (let i = chain.length - 1; i >= 0 && trusted(source); i--) source = chain[i];
  return { source_ip: source, source_kind: "trusted_proxy" };
}

/** Caller holds the heartbeat writer transaction and has checked host binding. */
export function recordHostNetwork(db: DB, machineID: string, agentID: string, addresses: HostNetworkAddress[] | undefined, source: NetworkSource | undefined, at: string): void {
  const previous = db.get<{agent_id:string}>("SELECT agent_id FROM machine_network_observations WHERE machine_id=?", machineID);
  if (previous && previous.agent_id !== agentID) db.run("DELETE FROM machine_network_observations WHERE machine_id=?", machineID);
  db.run("INSERT OR IGNORE INTO machine_network_observations(machine_id,agent_id) VALUES(?,?)", machineID, agentID);
  if (addresses !== undefined) db.run("UPDATE machine_network_observations SET addresses_json=?,observed_at=? WHERE machine_id=?", JSON.stringify(addresses), at, machineID);
  if (source !== undefined) db.run("UPDATE machine_network_observations SET source_ip=?,source_kind=?,source_observed_at=? WHERE machine_id=?", source.source_ip, source.source_kind, at, machineID);
}

export function machineNetwork(db: DB, machineID: string): MachineNetwork {
  const empty: MachineNetwork = { addresses: [], private_ips: [], public_ips: [], observed_at: "", source_ip: "", source_observed_at: "", source_kind: "unavailable" };
  if (!db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='machine_network_observations'")) return empty;
  const row = db.get<any>("SELECT n.* FROM machine_network_observations n JOIN managed_machines m ON m.id=n.machine_id AND m.agent_id=n.agent_id WHERE n.machine_id=?", machineID);
  if (!row) return empty;
  let addresses: HostNetworkAddress[];
  try { addresses = normalizeNetworkAddresses(JSON.parse(row.addresses_json)) ?? []; } catch { addresses = []; }
  return { addresses,
    private_ips: [...new Set(addresses.filter(item => item.scope === "private").map(item => item.address))],
    public_ips: [...new Set(addresses.filter(item => item.scope === "public").map(item => item.address))],
    observed_at: row.observed_at,
    source_ip: row.source_ip,
    source_observed_at: row.source_observed_at,
    source_kind: row.source_kind,
  };
}
