import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import type { NetworkInterfaceInfo } from "node:os";
import { DB } from "../src/shared/sqlite.js";
import { Router, HTTPError } from "../src/shared/http.js";
import type { Dependencies } from "../src/shared/types.js";
import { normalizeIPAddress, normalizeNetworkAddresses, networkScope } from "../src/shared/host-network.js";
import { collectNetworkAddresses } from "../src/agent/network-addresses.js";
import { NodeStore } from "../src/server/nodes-model.js";
import { registerNodes, type NodesOptions } from "../src/server/nodes.js";
import { machineNetwork, observeNetworkSource, trustedProxyMatcher } from "../src/server/host-network.js";

const nic = (address: string): NetworkInterfaceInfo => ({ address, netmask: "", family: address.includes(":") ? "IPv6" : "IPv4", mac: "secret-mac-should-not-be-sent", internal: false, cidr: null });
const entry = (address: string, name = "eth0") => ({ interface: name, address });
const request = (peer: string, header?: string) => ({ socket: { remoteAddress: peer }, headers: header === undefined ? {} : { "x-forwarded-for": header } }) as IncomingMessage;

test("local inventory includes multiple private dual-stack addresses and only bounded IP metadata", () => {
  const addresses = collectNetworkAddresses({
    eth0: [nic("10.1.2.3"), nic("10.1.2.3"), nic("fd12:3456::1"), nic("fe80::1"), nic("203.0.113.10")],
    en1: [nic("192.168.8.2"), nic("100.64.1.2"), nic("::ffff:192.168.1.3")],
    lo: [nic("127.0.0.1"), nic("::1"), nic("0.0.0.0"), nic("::")],
  })!;
  assert.equal(addresses.length, 9);
  assert.equal(addresses.filter(item => item.scope === "private").length, 5);
  assert.equal(addresses.find(item => item.address === "fe80::1")?.scope, "link_local");
  assert.equal(addresses.find(item => item.address === "::1")?.scope, "loopback");
  assert.equal(JSON.stringify(addresses).includes("secret-mac"), false);
  assert.equal(collectNetworkAddresses({eth0:Array.from({length:100}, (_, i) => nic(`10.0.0.${i+1}`))})!.length, 64);
  assert.deepEqual(collectNetworkAddresses({}), []);
});

test("IP normalization and private scope cover CIDR boundaries, ULA, CGNAT and mapped IPv6", () => {
  for (const address of ["10.255.0.1", "172.16.0.1", "172.31.255.254", "192.168.0.1", "100.64.0.1", "100.127.255.254", "fc00::1", "fdff::1", "::ffff:192.168.0.1", "::ffff:ac10:1"]) assert.equal(networkScope(address), "private", address);
  for (const address of ["172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1", "2001:db8::1"]) assert.equal(networkScope(address), "public", address);
  assert.equal(networkScope("::ffff:127.0.0.1"), "loopback");
  assert.equal(networkScope("::ffff:169.254.0.1"), "link_local");
  assert.equal(normalizeIPAddress("2001:0DB8:0:0::1"), "2001:db8::1");
  for (const invalid of ["test.example", "127.0.0.1:80", "[::1]", "fe80::1%eth0", "01.2.3.4", "::bad-ip"]) assert.equal(normalizeIPAddress(invalid), "");
  const normalized = normalizeNetworkAddresses([{...entry("10.0.0.1"),scope:"public"},entry("10.0.0.1")])!;
  assert.deepEqual(normalized, [{interface:"eth0",address:"10.0.0.1",family:"IPv4",scope:"private"}]);
  assert.throws(() => normalizeNetworkAddresses([{...entry("10.0.0.1"),family:"IPv6"}]));
  assert.throws(() => normalizeNetworkAddresses(Array.from({length:65},()=>entry("10.0.0.1"))));
  assert.throws(() => normalizeNetworkAddresses([entry("10.0.0.1", "bad\ninterface")]));
  assert.throws(() => normalizeNetworkAddresses([entry("0.0.0.0")]));
  assert.equal(normalizeNetworkAddresses(undefined), undefined);
});

test("source defaults to socket peer and ignores arbitrary forwarding headers", () => {
  assert.deepEqual(observeNetworkSource(request("10.4.0.3", "203.0.113.8"), trustedProxyMatcher()), {source_ip:"10.4.0.3",source_kind:"direct"});
  assert.deepEqual(observeNetworkSource(request("192.168.1.5", "203.0.113.8"), trustedProxyMatcher(["127.0.0.1"])), {source_ip:"192.168.1.5",source_kind:"direct"});
  assert.deepEqual(observeNetworkSource(request("bad-peer"), trustedProxyMatcher()), {source_ip:"",source_kind:"unavailable"});
});

test("trusted proxy chain walks from right, rejects malformed chains and never trusts spoofed prefixes", () => {
  const trusted = trustedProxyMatcher(["10.0.0.0/24", "::1/128"]);
  assert.deepEqual(observeNetworkSource(request("10.0.0.2", "198.51.100.1, 192.168.3.4, 10.0.0.8"), trusted), {source_ip:"192.168.3.4",source_kind:"trusted_proxy"});
  assert.deepEqual(observeNetworkSource(request("::1", "2001:db8::7"), trusted), {source_ip:"2001:db8::7",source_kind:"trusted_proxy"});
  assert.equal(trusted("::ffff:10.0.0.2"), true);
  for (const header of [undefined, "", "unknown", "10.1.1.1,", "198.51.100.1:1234", Array(34).fill("10.1.1.1").join(",")]) {
    const observed = observeNetworkSource(request("10.0.0.2", header), trusted);
    assert.deepEqual(observed, {source_ip:"",source_kind:"unavailable"});
  }
  for (const range of ["not-an-ip", "10.0.0.0/33", "::1/129", "10.0.0.1/-1", "10.0.0.1/", "10.0.0.1/2/3"]) assert.throws(() => trustedProxyMatcher([range]), /LIGHTMONI_TRUSTED_PROXIES/);
});

async function fixture(t: any, options: NodesOptions = {}) {
  const db = new DB(":memory:"), router = new Router();
  let at = new Date("2026-10-30T10:00:00.000Z");
  const deps = {db, router, now:()=>at, auth:{user:()=>({id:"admin",name:"admin",role:"admin"}),master:Buffer.alloc(32)},cat:{list:async()=>[]},logger:{info(){},warn(){},error(){}}} as unknown as Dependencies;
  router.auth = deps.auth;
  const agentCredentials = {authenticate(req:IncomingMessage,id:string){if(req.headers.authorization!=="Bearer fixture-control")throw new HTTPError(401,"bad control");return {credential_id:"control",agent_id:id};}} as any;
  const module = registerNodes(deps, {agentCredentials,...options}), store = new NodeStore(db,()=>at);
  db.exec("CREATE TABLE agent_enrollments(id TEXT PRIMARY KEY,agent_id TEXT,status TEXT,machine_id TEXT,created_at TEXT)");
  const server = createServer(async(req,res)=>{if(!await router.handle(req,res)){res.writeHead(404);res.end();}});
  server.listen(0,"127.0.0.1");await once(server,"listening");
  t.after(async()=>{await module.close?.();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();});
  const url = `http://127.0.0.1:${(server.address() as any).port}/api/v1`;
  return {db,store,advance(){at=new Date(at.getTime()+30_000);},enroll(agent="agent-1",machine="host-1"){
    db.run("INSERT INTO managed_machines(id,name,address,port,username,connection_method,agent_id,created_at,updated_at) VALUES(?,?,?,22,'root','direct_ssh',?,?,?)",machine,machine,"ssh.fixture.test",agent,at.toISOString(),at.toISOString());
    db.run("INSERT INTO agent_enrollments VALUES(?,?,'active',?,?)",agent,agent,machine,at.toISOString());
  },async post(path:string,body:any,headers:Record<string,string>={}){const response=await fetch(url+path,{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer fixture-control",...headers},body:JSON.stringify(body)});return {status:response.status,body:await response.json() as any};}};
}

test("authenticated register records local inventory and observed source, never Agent-provided egress claims", async t => {
  const f=await fixture(t);f.enroll();
  const denied=await f.post("/agents/register",{agent_id:"agent-1",network_addresses:[entry("10.1.1.3")]},{Authorization:"Bearer wrong"});
  assert.equal(denied.status,401);assert.equal(f.db.all("SELECT * FROM machine_network_observations").length,0);
  const response=await f.post("/agents/register",{agent_id:"agent-1",network_addresses:[entry("10.1.1.3"),entry("fd12::1")],source_ip:"203.0.113.199"},{"X-Forwarded-For":"203.0.113.200"});
  assert.equal(response.status,200,JSON.stringify(response.body));
  const network=machineNetwork(f.db,"host-1");
  assert.deepEqual(network.private_ips,["10.1.1.3","fd12::1"]);assert.equal(network.source_ip,"127.0.0.1");assert.equal(network.source_kind,"direct");
  assert.equal(network.observed_at,"2026-10-30T10:00:00.000Z");
  assert.deepEqual(f.store.hostDirectory()[0].network,network);
});

test("one authenticated heartbeat normalizes and persists both network addresses and Docker inventory",async t=>{
  const f=await fixture(t);f.enroll();
  const response=await f.post("/agents/register",{
    agent_id:"agent-1",network_addresses:[{...entry("10.2.3.4"),scope:"public",mac:"omit-network-secret"},entry("10.2.3.4"),entry("fd12:0000::2")],
    docker_inventory:{state:"ready",observed_at:"2026-10-30T10:00:00Z",containers:[{
      id:"a".repeat(64),name:"orders\n-app",image:"orders:1",state:"running",ports:"8080",deployment_id:"instance-a",
      environment:"omit-container-secret",command:"omit-command-secret",
    }]},
  });
  assert.equal(response.status,200,JSON.stringify(response.body));
  const network=machineNetwork(f.db,"host-1"),heartbeat=JSON.parse(f.db.get<any>("SELECT heartbeat FROM agents WHERE id='agent-1'")!.heartbeat);
  assert.deepEqual(network.private_ips,["10.2.3.4","fd12::2"]);
  assert.deepEqual(heartbeat.network_addresses,network.addresses);
  assert.equal(heartbeat.docker_inventory.observed_at,"2026-10-30T10:00:00.000Z");
  assert.equal(heartbeat.docker_inventory.truncated,false);
  assert.deepEqual(heartbeat.docker_inventory.containers,[{id:"a".repeat(64),name:"orders-app",image:"orders:1",state:"running",ports:"8080",deployment_id:"instance-a"}]);
  assert.doesNotMatch(JSON.stringify(heartbeat),/omit-network-secret|omit-container-secret|omit-command-secret/);
});

test("legacy heartbeat preserves last snapshot timestamp; explicit empty snapshot clears it",async t=>{
  const f=await fixture(t);f.enroll();
  assert.equal((await f.post("/agents/register",{agent_id:"agent-1",network_addresses:[entry("192.168.1.4")]})).status,200);
  const first=machineNetwork(f.db,"host-1");f.advance();
  assert.equal((await f.post("/agents/agent-1/heartbeat",{hostname:"renamed"})).status,200);
  const legacy=machineNetwork(f.db,"host-1");assert.deepEqual(legacy.addresses,first.addresses);assert.equal(legacy.observed_at,first.observed_at);assert.notEqual(legacy.source_observed_at,first.source_observed_at);
  f.advance();assert.equal((await f.post("/agents/agent-1/heartbeat",{network_addresses:[]})).status,200);
  assert.deepEqual(machineNetwork(f.db,"host-1").private_ips,[]);assert.equal(machineNetwork(f.db,"host-1").observed_at,"2026-10-30T10:01:00.000Z");
});

test("invalid inventory and unregistered identity roll back node and network writes",async t=>{
  const f=await fixture(t);f.enroll();
  assert.equal((await f.post("/agents/register",{agent_id:"agent-1",network_addresses:[entry("not-an-ip")]})).status,400);
  assert.equal(f.db.all("SELECT * FROM agents").length,0);assert.equal(f.db.all("SELECT * FROM machine_network_observations").length,0);
  assert.equal((await f.post("/agents/register",{agent_id:"unregistered",network_addresses:[entry("10.0.0.1")]})).status,409);
  assert.equal(f.db.all("SELECT * FROM agents").length,0);assert.equal(f.db.all("SELECT * FROM machine_network_observations").length,0);
});

test("same IP never merges hosts; reinstallation cannot show the previous Agent snapshot; deletion cascades",async t=>{
  const f=await fixture(t);f.enroll();f.enroll("agent-2","host-2");
  for(const id of ["agent-1","agent-2"])assert.equal((await f.post("/agents/register",{agent_id:id,network_addresses:[entry("10.0.0.1")]})).status,200);
  assert.equal(f.db.all("SELECT id FROM managed_machines").length,2);
  f.db.run("UPDATE managed_machines SET agent_id='replacement' WHERE id='host-1'");
  assert.deepEqual(machineNetwork(f.db,"host-1").private_ips,[]);
  f.db.run("INSERT INTO agent_enrollments VALUES('replacement','replacement','active','host-1','2026-10-30T10:01:00.000Z')");
  assert.equal((await f.post("/agents/register",{agent_id:"replacement"})).status,200);
  assert.deepEqual(machineNetwork(f.db,"host-1").addresses,[]);
  assert.deepEqual(machineNetwork(f.db,"host-2").private_ips,["10.0.0.1"]);
  f.db.run("DELETE FROM managed_machines WHERE id='host-1'");assert.equal(f.db.all("SELECT * FROM machine_network_observations").length,1);
});

test("trusted-proxy HTTP path persists a private observed source and marks missing chain unavailable",async t=>{
  const f=await fixture(t,{trustedProxies:["127.0.0.1/32"]});f.enroll();
  assert.equal((await f.post("/agents/register",{agent_id:"agent-1"},{"X-Forwarded-For":"192.168.2.4"})).status,200);
  assert.equal(machineNetwork(f.db,"host-1").source_ip,"192.168.2.4");assert.equal(machineNetwork(f.db,"host-1").source_kind,"trusted_proxy");
  assert.equal((await f.post("/agents/agent-1/heartbeat",{})).status,200);
  assert.equal(machineNetwork(f.db,"host-1").source_ip,"");assert.equal(machineNetwork(f.db,"host-1").source_kind,"unavailable");
});
