import { BlockList, isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import type { DB } from "../shared/sqlite.js";
import { normalizeIPAddress, normalizeNetworkAddresses, networkScope, type HostNetworkAddress } from "../shared/host-network.js";

export type SourceKind = "direct" | "trusted_proxy" | "unavailable";
export interface NetworkSource { source_ip: string; source_kind: SourceKind }
export interface MachineNetwork {
  hostname: string;
  observed_via: "ssh" | "agent" | "unavailable";
  addresses: HostNetworkAddress[];
  private_ips: string[];
  public_ips: string[];
  observed_at: string;
  source_ip: string;
  source_observed_at: string;
  source_kind: SourceKind;
}

export function createHostNetworkSchema(db: DB): void {
  // DDL and the one-time ownership backfill must commit together. SAVEPOINT
  // also works when schema setup runs inside a caller's write transaction.
  db.exec("SAVEPOINT lightmoni_host_network_schema");
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS machine_network_observations(
      machine_id TEXT PRIMARY KEY REFERENCES managed_machines(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      addresses_json TEXT NOT NULL DEFAULT '[]',
      observed_at TEXT NOT NULL DEFAULT '',
      source_ip TEXT NOT NULL DEFAULT '',
      source_observed_at TEXT NOT NULL DEFAULT '',
      source_kind TEXT NOT NULL DEFAULT 'unavailable',
      observed_via TEXT NOT NULL DEFAULT 'unavailable',
      snapshot_agent_id TEXT NOT NULL DEFAULT '',
      snapshot_ssh_generation INTEGER NOT NULL DEFAULT -1,
      snapshot_host_key_fingerprint TEXT NOT NULL DEFAULT '',
      hostname TEXT NOT NULL DEFAULT ''
    )`);
    const columns = new Set(db.all<{name:string}>("PRAGMA table_info(machine_network_observations)").map(row => row.name));
    for (const [name, definition] of [
      ["observed_via", "TEXT NOT NULL DEFAULT 'agent'"],
      ["snapshot_agent_id", "TEXT NOT NULL DEFAULT ''"],
      ["snapshot_ssh_generation", "INTEGER NOT NULL DEFAULT -1"],
      ["snapshot_host_key_fingerprint", "TEXT NOT NULL DEFAULT ''"],
      ["hostname", "TEXT NOT NULL DEFAULT ''"],
    ]) if (!columns.has(name)) db.exec(`ALTER TABLE machine_network_observations ADD COLUMN ${name} ${definition}`);
    // Only the migration that introduces snapshot_agent_id may backfill it.
    // Later source owners must never become an earlier snapshot's identity.
    if (!columns.has("snapshot_agent_id")) db.run("UPDATE machine_network_observations SET snapshot_agent_id=agent_id WHERE observed_via='agent'");
    db.exec("RELEASE lightmoni_host_network_schema");
  } catch (error) {
    try { db.exec("ROLLBACK TO lightmoni_host_network_schema"); }
    finally { db.exec("RELEASE lightmoni_host_network_schema"); }
    throw error;
  }
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

interface HostIdentity { id: string; agent_id: string; ssh_target_generation: number; host_key_fingerprint: string }
const snapshotCurrent = (row: any, host: HostIdentity): boolean => Number.isFinite(Date.parse(row?.observed_at)) && (
  row.observed_via === "agent" && !!row.snapshot_agent_id && row.snapshot_agent_id === host.agent_id
  || row.observed_via === "ssh" && Number(row.snapshot_ssh_generation) === Number(host.ssh_target_generation)
    && !!row.snapshot_host_key_fingerprint && row.snapshot_host_key_fingerprint === host.host_key_fingerprint
);
const mayReplace = (row: any, host: HostIdentity, at: string): boolean => !snapshotCurrent(row, host)
  || Date.parse(at) >= Date.parse(row.observed_at);
const safeHostname = (value: unknown): string => typeof value === "string" && Buffer.byteLength(value.trim()) <= 128
  && !/[\u0000-\u001f\u007f-\u009f]/.test(value) ? value.trim() : "";
const identity = (db: DB, machineID: string) => db.get<HostIdentity>("SELECT id,agent_id,ssh_target_generation,host_key_fingerprint FROM managed_machines WHERE id=?", machineID);

/** Caller holds the heartbeat writer transaction and has checked host binding. */
export function recordHostNetwork(db: DB, machineID: string, agentID: string, addresses: HostNetworkAddress[] | undefined, source: NetworkSource | undefined, at: string, hostname?: unknown): void {
  const host = identity(db, machineID);
  if (!host || host.agent_id !== agentID || !Number.isFinite(Date.parse(at))) throw Error("invalid network observation identity");
  const previous = db.get<any>("SELECT * FROM machine_network_observations WHERE machine_id=?", machineID);
  db.run("INSERT OR IGNORE INTO machine_network_observations(machine_id,agent_id) VALUES(?,'')", machineID);
  if (addresses !== undefined && mayReplace(previous, host, at)) db.run(`UPDATE machine_network_observations
    SET addresses_json=?,observed_at=?,observed_via='agent',snapshot_agent_id=?,snapshot_ssh_generation=-1,snapshot_host_key_fingerprint='',hostname=? WHERE machine_id=?`,
    JSON.stringify(addresses), at, agentID, safeHostname(hostname), machineID);
  // Connection provenance has its own owner and clock; a new identity must
  // never inherit a previous Agent's source just because an SSH sample exists.
  if (source !== undefined && (previous?.agent_id !== agentID || !previous?.source_observed_at || Date.parse(at) >= Date.parse(previous.source_observed_at)))
    db.run("UPDATE machine_network_observations SET agent_id=?,source_ip=?,source_kind=?,source_observed_at=? WHERE machine_id=?", agentID, source.source_ip, source.source_kind, at, machineID);
}

/** A successful optional preflight sample, never a platform connection source. */
export function recordSSHHostNetwork(db: DB, expected: { id: string; ssh_target_generation: number; host_key_fingerprint: string }, snapshot: {hostname: string;addresses: HostNetworkAddress[];observed_at: string}, stillAuthorized: () => boolean = () => true): boolean {
  return db.transaction(() => {
    if (!stillAuthorized()) return false;
    const host = identity(db, expected.id);
    if (!host || Number(host.ssh_target_generation) !== Number(expected.ssh_target_generation) || !expected.host_key_fingerprint
      || host.host_key_fingerprint !== expected.host_key_fingerprint || !Number.isFinite(Date.parse(snapshot.observed_at))) return false;
    const addresses = normalizeNetworkAddresses(snapshot.addresses), hostname = safeHostname(snapshot.hostname);
    if (!addresses || !hostname) return false;
    const previous = db.get<any>("SELECT * FROM machine_network_observations WHERE machine_id=?", host.id);
    if (!mayReplace(previous, host, snapshot.observed_at)) return true;
    db.run("INSERT OR IGNORE INTO machine_network_observations(machine_id,agent_id) VALUES(?,'')", host.id);
    db.run(`UPDATE machine_network_observations SET addresses_json=?,observed_at=?,observed_via='ssh',snapshot_agent_id='',snapshot_ssh_generation=?,snapshot_host_key_fingerprint=?,hostname=? WHERE machine_id=?`,
      JSON.stringify(addresses), snapshot.observed_at, host.ssh_target_generation, host.host_key_fingerprint, hostname, host.id);
    return true;
  });
}

export function machineNetwork(db: DB, machineID: string): MachineNetwork {
  const empty: MachineNetwork = { hostname: "", observed_via: "unavailable", addresses: [], private_ips: [], public_ips: [], observed_at: "", source_ip: "", source_observed_at: "", source_kind: "unavailable" };
  if (!db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='machine_network_observations'")) return empty;
  const host = identity(db, machineID), row = db.get<any>("SELECT * FROM machine_network_observations WHERE machine_id=?", machineID);
  if (!row || !host) return empty;
  let addresses: HostNetworkAddress[];
  const current = snapshotCurrent(row, host), sourceCurrent = !!row.agent_id && row.agent_id === host.agent_id;
  try { addresses = current ? normalizeNetworkAddresses(JSON.parse(row.addresses_json)) ?? [] : []; } catch { addresses = []; }
  return { addresses, hostname: current ? safeHostname(row.hostname) : "", observed_via: current ? row.observed_via : "unavailable",
    private_ips: [...new Set(addresses.filter(item => item.scope === "private").map(item => item.address))],
    public_ips: [...new Set(addresses.filter(item => item.scope === "public").map(item => item.address))],
    observed_at: current ? row.observed_at : "",
    source_ip: sourceCurrent ? row.source_ip : "",
    source_observed_at: sourceCurrent ? row.source_observed_at : "",
    source_kind: sourceCurrent ? row.source_kind : "unavailable",
  };
}

/** The shared source for service/DNS addresses of a managed machine. SSH DNS names and observed proxy peers are never service addresses. */
export function machineServiceAddresses(db: DB, machineID: string) {
  const network = machineNetwork(db, machineID);
  const usable = network.addresses.filter(n => !/^(?:lo$|docker|br-|veth|virbr|cni|flannel|cali|kube)/i.test(n.interface));
  const private_ips = [...new Set(usable.filter(n => n.scope === 'private').map(n => n.address))];
  const public_ips = [...new Set(usable.filter(n => n.scope === 'public').map(n => n.address))];
  const ipv4First = (a:string,b:string) => Number(isIP(b)===4)-Number(isIP(a)===4);
  private_ips.sort(ipv4First);public_ips.sort(ipv4First);
  let legacy = '';
  if (!network.addresses.length) legacy = normalizeIPAddress(db.get<{address:string}>('SELECT address FROM managed_machines WHERE id=?',machineID)?.address);
  if (legacy && networkScope(legacy) === 'private') private_ips.push(legacy);
  if (legacy && networkScope(legacy) === 'public') public_ips.push(legacy);
  return {address:private_ips[0] ?? public_ips[0] ?? (legacy && networkScope(legacy)==='loopback' ? legacy : ''),public_address:public_ips[0] ?? '',private_ips,public_ips};
}
