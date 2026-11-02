import { BlockList, isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import type { DB } from "../shared/sqlite.js";
import { fail } from "../shared/http.js";
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
  service_addresses?: MachineServiceAddressSettings;
}

export function createHostNetworkSchema(db: DB): void {
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
    db.exec(`CREATE TABLE IF NOT EXISTS machine_service_address_settings(
      machine_id TEXT PRIMARY KEY REFERENCES managed_machines(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      private_mode TEXT NOT NULL,private_address TEXT NOT NULL DEFAULT '',
      public_mode TEXT NOT NULL,public_address TEXT NOT NULL DEFAULT '',
      target_generation INTEGER NOT NULL DEFAULT 0,
      updated_by TEXT NOT NULL,updated_at TEXT NOT NULL
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
  const value = machineServiceAddressSettings(db, machineID);
  const private_ips = value.private.effective_addresses, public_ips = value.public.effective_addresses;
  return {address:value.private.needs_confirmation?'':private_ips[0] ?? public_ips[0] ?? '',public_address:public_ips[0] ?? '',private_ips,public_ips};
}

type AddressScope = 'private'|'public';
type AddressMode = 'auto'|'manual';
export type ServiceAddressCandidate = {address:string;scope:AddressScope;source:'interface'|'ssh_target'|'platform_source';interface?:string;observed_at:string;requires_confirmation:boolean};
type ServiceAddressChoice = {mode:AddressMode;address:string;effective:string;effective_addresses:string[];source:'interface'|'manual'|'unavailable';needs_confirmation:boolean};
export type MachineServiceAddressSettings = {revision:number;target_generation:number;private:ServiceAddressChoice;public:ServiceAddressChoice;candidates:ServiceAddressCandidate[];updated_by:string;updated_at:string};
const ordinaryInterface = (name:string) => !/^(?:lo$|docker|br-|veth|virbr|cni|flannel|cali|kube|tun\d|tap\d|utun\d|wg\d|tailscale|zt[0-9a-f])/i.test(name);
const tablePresent = (db:DB,name:string) => !!db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?",name);

/** A conservative public range check, matching the host network display. It is not a reachability probe. */
export function validServiceAddress(value:unknown,scope:AddressScope):string {
  const ip=normalizeIPAddress(value),family=isIP(ip);
  if(!ip)return '';
  if(scope==='private')return networkScope(ip)==='private'?ip:'';
  if(networkScope(ip)!=='public')return '';
  if(family===4){
    const [a,b,c]=ip.split('.').map(Number);
    if(a===0||a>=224||a===192&&(b===0&&(c===0||c===2)||b===88&&c===99)||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113)return '';
  }else{
    const words=ip.split(':').slice(0,2).map(v=>parseInt(v||'0',16)),[a,b]=words;
    if((a&0xe000)!==0x2000||a===0x2001&&((b&0xfe00)===0||b===0x0db8)||a===0x2002||a===0x3ffe||a===0x3fff&&(b&0xf000)===0)return '';
  }
  return ip;
}

export function machineServiceAddressSettings(db:DB,machineID:string):MachineServiceAddressSettings {
  const host=tablePresent(db,'managed_machines')?db.get<any>('SELECT * FROM managed_machines WHERE id=?',machineID):undefined;
  const network=machineNetwork(db,machineID),row=tablePresent(db,'machine_service_address_settings')?db.get<any>('SELECT * FROM machine_service_address_settings WHERE machine_id=?',machineID):undefined;
  const candidates:ServiceAddressCandidate[]=network.addresses.filter(n=>ordinaryInterface(n.interface)&&['private','public'].includes(n.scope)).map(n=>({address:n.address,scope:n.scope as AddressScope,source:'interface',interface:n.interface,observed_at:network.observed_at,requires_confirmation:false}));
  const appendCandidate=(raw:string,source:'ssh_target'|'platform_source')=>{
    const ip=normalizeIPAddress(raw);if(!ip)return;
    const scope=networkScope(ip);
    if(scope!=='private'&&scope!=='public'||source==='platform_source'&&scope!=='public')return;
    if(!validServiceAddress(ip,scope))return;
    candidates.push({address:ip,scope,source,observed_at:source==='platform_source'?network.source_observed_at:'',requires_confirmation:true});
  };
  appendCandidate(host?.address??'','ssh_target');appendCandidate(network.source_ip,'platform_source');
  const target_generation=Number(host?.ssh_target_generation??0);
  const choice=(scope:AddressScope):ServiceAddressChoice=>{
    const mode:AddressMode=row?.[scope+'_mode']==='manual'?'manual':'auto',address=mode==='manual'?String(row?.[scope+'_address']??''):'';
    const needs_confirmation=mode==='manual'&&(Number(row.target_generation)!==target_generation||!validServiceAddress(address,scope));
    const auto=[...new Set(candidates.filter(c=>c.scope===scope&&c.source==='interface').map(c=>c.address))].sort((a,b)=>Number(isIP(b)===4)-Number(isIP(a)===4));
    const effective_addresses=mode==='manual'?(needs_confirmation?[]:[address]):auto;
    return {mode,address,effective:effective_addresses[0]??'',effective_addresses,source:effective_addresses.length?(mode==='manual'?'manual':'interface'):'unavailable',needs_confirmation};
  };
  return {revision:Number(row?.revision??0),target_generation,private:choice('private'),public:choice('public'),candidates,updated_by:row?.updated_by??'',updated_at:row?.updated_at??''};
}

export function saveMachineServiceAddresses(db:DB,machineID:string,input:any,actor:string,at:string):MachineServiceAddressSettings {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['revision','target_generation','private','public'].includes(k)))fail(400,'invalid_service_address_settings');
  if(!Number.isSafeInteger(input.revision)||input.revision<0||!Number.isSafeInteger(input.target_generation)||input.target_generation<0)fail(400,'invalid_service_address_revision');
  const parse=(scope:AddressScope)=>{
    const value=input[scope];
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['mode','address'].includes(k))||!['auto','manual'].includes(value.mode)||typeof value.address!=='string')fail(400,'invalid_'+scope+'_service_address');
    if(value.mode==='auto'){if(value.address!=='')fail(400,'invalid_'+scope+'_service_address');return{mode:'auto',address:''};}
    const address=validServiceAddress(value.address,scope);if(!address)fail(400,'invalid_'+scope+'_service_address');return{mode:'manual',address};
  };
  const privateValue=parse('private'),publicValue=parse('public');
  return db.transaction(()=>{
    const host=db.get<any>('SELECT * FROM managed_machines WHERE id=?',machineID);if(!host)fail(404,'主机不存在');
    const current=db.get<any>('SELECT revision FROM machine_service_address_settings WHERE machine_id=?',machineID);
    if(Number(current?.revision??0)!==input.revision)fail(409,'machine_service_address_revision_conflict');
    if(Number(host.ssh_target_generation??0)!==input.target_generation)fail(409,'machine_network_target_changed');
    db.run(`INSERT INTO machine_service_address_settings(machine_id,revision,private_mode,private_address,public_mode,public_address,target_generation,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(machine_id) DO UPDATE SET revision=excluded.revision,private_mode=excluded.private_mode,private_address=excluded.private_address,public_mode=excluded.public_mode,public_address=excluded.public_address,target_generation=excluded.target_generation,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
      machineID,input.revision+1,privateValue.mode,privateValue.address,publicValue.mode,publicValue.address,input.target_generation,actor,at);
    return machineServiceAddressSettings(db,machineID);
  });
}
