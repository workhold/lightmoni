import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { execFileSync, execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import ssh2 from "ssh2";
import { DB } from "../src/shared/sqlite.js";
import { Router, fail } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import type { Dependencies } from "../src/shared/types.js";
import { createAgentHostSchema } from "../src/server/agent-hosts.js";
import { createHostNetworkSchema, machineNetwork, recordHostNetwork, recordSSHHostNetwork } from "../src/server/host-network.js";
import { defaultSSHRunner, parsePreflight, preflightCommand, type SSHRunner } from "../src/server/machine-ssh.js";
import { registerManagedMachines } from "../src/server/managed-machines.js";
import { fixturePrivateKey } from "./helpers/ssh-key.js";

const at = "2026-10-31T10:00:00.000Z", pin = "SHA256:isolated-fixture";
const core = "LMSSH=1\nplatform=linux\narch=amd64\nlinux=1\nsupported_arch=1\ncurl=1\ntar=1\ngzip=1\nsha256sum=1\nsystemd=1\nprivilege_state=root\ninstall_privilege=1\nplatform_https=1\nagent_installation=absent\n";
// iproute2 `ip -j -brief address show`: family is normally absent in brief mode.
const brief = [
  {ifname:"lo",operstate:"UNKNOWN",addr_info:[{local:"127.0.0.1",prefixlen:8},{local:"::1",prefixlen:128}]},
  {ifname:"eth0@if52",operstate:"UP",addr_info:[{local:"10.12.3.4",prefixlen:24},{local:"fd12:0000::4",prefixlen:64}]},
  {ifname:"docker0",operstate:"DOWN",addr_info:[{local:"172.17.0.1",prefixlen:16}]},
  {ifname:"br-123456789abc",operstate:"UP",addr_info:[{local:"172.20.0.1",prefixlen:16}]},
  {ifname:"veth1234@if99",operstate:"UP",addr_info:[{local:"fe80::2",prefixlen:64}]},
];
const block = (json = JSON.stringify(brief), hostname = "fixture-db") => `LMNET_BEGIN=1\nhostname_hex=${Buffer.from(hostname).toString("hex")}\naddresses_json=${json}\nLMNET_END=1\n`;

test("optional brief discovery normalizes dual-stack, bridges and hostname without preserving unrelated metadata", () => {
  const result = parsePreflight(core + block(), at);
  assert.equal(result.ready, true);
  assert.equal(result.discovery.status, "succeeded");
  assert.equal(result.discovery.hostname, "fixture-db");
  assert.equal(result.discovery.observed_at, at);
  assert.equal(result.discovery.addresses.length, 7);
  assert.ok(result.discovery.addresses.some(item => item.address === "fd12::4" && item.scope === "private"));
  assert.ok(result.discovery.addresses.some(item => item.interface === "veth1234@if99" && item.scope === "link_local"));
  assert.doesNotMatch(JSON.stringify(result.discovery), /prefixlen|operstate/);
  assert.deepEqual(parsePreflight(core + block("[]"), at).discovery.addresses, []);
  assert.equal(parsePreflight(core + block("[]"), at).discovery.status, "succeeded");
});

test("missing tools and malformed or excessive optional discovery never change core readiness", () => {
  const bad = [
    "", "LMNET_BEGIN=1\nLMNET_END=1\n", block("{"), block(" ".repeat(8193)),
    block(JSON.stringify([{ifname:"eth0",addr_info:Array.from({length:65}, (_,i)=>({local:`10.0.0.${i+1}`}))}])),
    block(JSON.stringify([{ifname:"eth\n0",addr_info:[{local:"10.0.0.1"}]}])),
    block(JSON.stringify([{ifname:"eth0",addr_info:[{family:"inet6",local:"10.0.0.1"}]}])),
    block(JSON.stringify([{ifname:"eth0",addr_info:[{local:"not-an-ip"}]}])),
    block("[]", "bad\u0000host"), block("[]", "x".repeat(129)),
    block().replace("LMNET_END=1", "LMNET_END=0"), block()+"unexpected\n",
  ];
  for (const optional of bad) {
    const result = parsePreflight(core + optional, at);
    assert.equal(result.ready, true);
    assert.deepEqual(result.discovery, {status:"unavailable",hostname:"",addresses:[],observed_at:""});
  }
  assert.throws(() => parsePreflight(core + "curl=1\n" + block(), at), /invalid_response/);
  assert.throws(() => parsePreflight(core.replace("curl=1", "curl=yes") + block(), at), /invalid_response/);
  assert.equal(parsePreflight(core.replace("curl=1", "curl=0") + block(), at).discovery.status, "succeeded");
});

test("fixed shell bounds optional stdout beneath the runner 12KB window even when ip emits too much", t => {
  const directory = mkdtempSync(join(tmpdir(), "lightmoni-discovery-shell-"));
  t.after(() => rmSync(directory, {recursive:true,force:true}));
  const write = (name:string, text:string) => writeFileSync(join(directory,name), text, {mode:0o700});
  write("timeout", '#!/bin/sh\nshift\nexec "$@"\n');
  write("uname", "#!/bin/sh\nprintf 'fixture-db\\n'\n");
  write("ip", `#!/bin/sh\nprintf '%s' '${"x".repeat(30_000)}'\n`);
  const command = preflightCommand("https://platform.example"), optional = command.slice(command.indexOf("printf 'LMNET_BEGIN=1"));
  assert.match(optional, /ip -j -brief address show/);
  // Keep fake producers inside this shell; macOS may gate each newly written
  // executable independently. The production pipelines and byte limits remain.
  const producers = `timeout(){ shift; "$@"; }; uname(){ printf 'fixture-db\\n'; }; ip(){ printf '%s' '${"x".repeat(30_000)}'; };\n`;
  const stdout = execFileSync("sh", ["-c",producers+optional], {env:{...process.env,PATH:"/usr/bin:/bin"},encoding:"utf8",timeout:5000});
  assert.ok(Buffer.byteLength(core+stdout) < 12_000);
  assert.equal(parsePreflight(core+stdout, at).ready, true);
  assert.equal(parsePreflight(core+stdout, at).discovery.status, "unavailable");
});

function networkDB(t:any) {
  const db = new DB(":memory:"); createAgentHostSchema(db); createHostNetworkSchema(db);
  db.run("INSERT INTO managed_machines(id,name,address,port,username,connection_method,host_key_fingerprint,created_at,updated_at) VALUES('host','User name','ssh.fixture',22,'root','direct_ssh',?,?,?)", pin,at,at);
  t.after(() => db.close());
  return db;
}
const expected = {id:"host",ssh_target_generation:0,host_key_fingerprint:pin};
const snapshot = (time = at, address = "10.2.3.4") => ({hostname:"ssh-host",addresses:[{interface:"eth0",address,family:"IPv4" as const,scope:"private" as const}],observed_at:time});

test("SSH samples persist before Agent installation without changing asset identity or claiming a platform source", t => {
  const db = networkDB(t);
  assert.equal(recordSSHHostNetwork(db, expected, snapshot()), true);
  const network = machineNetwork(db,"host");
  assert.equal(network.hostname,"ssh-host");assert.equal(network.observed_via,"ssh");assert.equal(network.observed_at,at);
  assert.deepEqual(network.private_ips,["10.2.3.4"]);assert.equal(network.source_ip,"");assert.equal(network.source_kind,"unavailable");
  assert.deepEqual(db.get("SELECT name,address,agent_id FROM managed_machines WHERE id='host'"),{name:"User name",address:"ssh.fixture",agent_id:""});
  db.run("UPDATE managed_machines SET ssh_target_generation=1 WHERE id='host'");
  assert.equal(machineNetwork(db,"host").observed_via,"unavailable");
  assert.equal(recordSSHHostNetwork(db, expected, snapshot()),false);
  db.run("UPDATE managed_machines SET ssh_target_generation=0,host_key_fingerprint='SHA256:other' WHERE id='host'");
  assert.equal(machineNetwork(db,"host").hostname,"");assert.equal(recordSSHHostNetwork(db,expected,snapshot()),false);
});

test("latest valid successful sample wins while absent Agent inventory preserves SSH and source remains independent", t => {
  const db = networkDB(t);recordSSHHostNetwork(db,expected,snapshot());
  db.run("UPDATE managed_machines SET agent_id='agent-1' WHERE id='host'");
  const source = {source_ip:"192.168.8.3",source_kind:"direct" as const};
  recordHostNetwork(db,"host","agent-1",snapshot().addresses,source,"2026-10-31T10:01:00.000Z","agent-host");
  assert.equal(machineNetwork(db,"host").observed_via,"agent");
  recordSSHHostNetwork(db,expected,snapshot("2026-10-31T10:02:00.000Z","10.3.4.5"));
  let network=machineNetwork(db,"host");assert.equal(network.observed_via,"ssh");assert.equal(network.source_ip,source.source_ip);
  recordHostNetwork(db,"host","agent-1",snapshot().addresses,source,"2026-10-31T10:01:30.000Z","older-agent");
  assert.equal(machineNetwork(db,"host").hostname,"ssh-host");
  recordHostNetwork(db,"host","agent-1",undefined,source,"2026-10-31T10:03:00.000Z","missing-inventory");
  network=machineNetwork(db,"host");assert.deepEqual(network.private_ips,["10.3.4.5"]);assert.equal(network.observed_via,"ssh");
  assert.equal(network.source_observed_at,"2026-10-31T10:03:00.000Z");
  db.run("UPDATE managed_machines SET agent_id='agent-2' WHERE id='host'");
  network=machineNetwork(db,"host");assert.equal(network.observed_via,"ssh");assert.equal(network.source_ip,"");
  recordHostNetwork(db,"host","agent-2",undefined,source,"2026-10-31T10:04:00.000Z");
  assert.equal(machineNetwork(db,"host").observed_via,"ssh");
  recordHostNetwork(db,"host","agent-2",[],source,"2026-10-31T10:05:00.000Z","new-agent");
  network=machineNetwork(db,"host");assert.equal(network.observed_via,"agent");assert.deepEqual(network.addresses,[]);
  db.run("UPDATE managed_machines SET agent_id='agent-3' WHERE id='host'");
  network=machineNetwork(db,"host");assert.equal(network.observed_via,"unavailable");assert.equal(network.source_ip,"");assert.equal(network.hostname,"");
});

test("SSH target changes do not erase the independently bound current Agent source", t => {
  const db=networkDB(t);db.run("UPDATE managed_machines SET agent_id='agent' WHERE id='host'");
  recordHostNetwork(db,"host","agent",snapshot().addresses,{source_ip:"10.0.8.3",source_kind:"direct"},at,"agent-host");
  recordSSHHostNetwork(db,expected,snapshot("2026-10-31T10:01:00.000Z"));
  db.run("UPDATE managed_machines SET ssh_target_generation=1 WHERE id='host'");
  const network=machineNetwork(db,"host");assert.deepEqual(network.addresses,[]);assert.equal(network.source_ip,"10.0.8.3");
});

test("network schema savepoint composes with an outer transaction without committing it", t => {
  const db=new DB(":memory:");t.after(()=>db.close());createAgentHostSchema(db);
  assert.throws(()=>db.transaction(()=>{createHostNetworkSchema(db);throw Error("outer fixture rollback");}),/outer fixture rollback/);
  assert.equal(db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='machine_network_observations'"),undefined);
  db.transaction(()=>{createHostNetworkSchema(db);createHostNetworkSchema(db);});
  assert.ok(db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='machine_network_observations'"));
});

async function machineFixture(t:any, runner:SSHRunner=defaultSSHRunner) {
  const db=new DB(":memory:"), router=new Router(), encryption=cipher(Buffer.alloc(32,19));
  db.exec("CREATE TABLE agents(id TEXT PRIMARY KEY,last_seen TEXT NOT NULL DEFAULT '')");
  let time=new Date(at);
  const user={id:"admin",name:"Admin",role:"admin"};
  const deps={db,router,...encryption,now:()=>time,auth:{master:Buffer.alloc(32,19),user:()=>user,requireAdmin:(ctx:any)=>{if(ctx.user.role!=="admin")fail(403,"administrator required")}},externalURL:"https://platform.fixture",logger:{info(){},warn(){},error(){}}} as unknown as Dependencies;
  router.auth=deps.auth;
  const machines=registerManagedMachines(deps,{sshRunner:runner});
  const server=createServer(async(req,res)=>{if(!await router.handle(req,res)){res.writeHead(404);res.end();}});
  server.listen(0,"127.0.0.1");await once(server,"listening");
  t.after(async()=>{machines.close?.();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();});
  const url=`http://127.0.0.1:${(server.address() as any).port}/api/v1`;
  const request=async(path:string,method="GET",body?:unknown)=>{const response=await fetch(url+path,{method,headers:body?{"Content-Type":"application/json"}:undefined,body:body?JSON.stringify(body):undefined});assert.ok(response.ok,`fixture API ${path} returned ${response.status}`);return await response.json() as any;};
  return {db,machines,request,advance(){time=new Date(time.getTime()+30_000);},async create(options:{address?:string;port?:number;pin?:string;password?:string;method?:"password"|"ssh_key"}={}){
    const host=await request("/machines","POST",{name:"User configured name",address:options.address??"ssh.fixture",port:options.port??22,username:"fixture"});
    db.run("UPDATE managed_machines SET host_key_fingerprint=? WHERE id=?",options.pin??pin,host.id);
    const method=options.method??"password";
    const binding=await request(`/machines/${host.id}/credentials`,"POST",{method,secret:method==="password"?options.password??"fixture-only-password":fixturePrivateKey(),retention:"managed",confirm_managed:true});
    return {id:host.id,credentialID:binding.credential_id};
  }};
}

test("SSH preflight persists discovered addresses even when installation conditions fail, then preserves them on discovery failure",async t=>{
  let output=core.replace("systemd=1","systemd=0")+block(), calls=0;
  const f=await machineFixture(t,async input=>{calls++;assert.match(input.command,/ip -j -brief address show/);return {stdout:output,stderr:"untrusted remote diagnostic",stages:[]};});
  const host=await f.create();
  const first=await f.request(`/machines/${host.id}/ssh-check`,"POST",{});
  assert.equal(calls,1);assert.equal(first.ready,false);assert.equal(first.error_code,"prerequisites_missing");assert.equal(first.discovery.status,"succeeded");
  const detail=await f.request(`/machines/${host.id}`);
  assert.equal(detail.machine.network.observed_via,"ssh");assert.equal(detail.machine.network.hostname,"fixture-db");assert.equal(detail.machine.name,"User configured name");
  assert.equal(detail.machine.network.source_ip,"");assert.doesNotMatch(JSON.stringify(first),/untrusted remote diagnostic/);
  f.advance();output=core+block("invalid");
  const second=await f.request(`/machines/${host.id}/ssh-check`,"POST",{});
  assert.equal(second.ready,true);assert.equal(second.discovery.status,"unavailable");
  assert.equal((await f.request(`/machines/${host.id}`)).machine.network.observed_at,at);
  assert.equal(JSON.parse(f.db.get<any>("SELECT result_json FROM machine_ssh_checks WHERE id=?",first.id)!.result_json).discovery.hostname,"fixture-db");
});

test("target mutation, cancellation and credential invalidation cannot persist SSH metadata",async t=>{
  for (const action of ["target","cancel","revoke"] as const) {
    let f:Awaited<ReturnType<typeof machineFixture>>,controller=new AbortController();
    f=await machineFixture(t,async input=>{
      if(action==="target")f.db.run("UPDATE managed_machines SET address='changed.fixture',ssh_target_generation=ssh_target_generation+1 WHERE id=?",input.machine.id);
      if(action==="cancel")controller.abort();
      if(action==="revoke")f.db.run("UPDATE machine_credentials SET revoked_at=? WHERE id=?",at,input.credentialID!);
      return {stdout:core+block(),stderr:"",stages:[]};
    });
    const host=await f.create({method:action==="target"?"ssh_key":"password"});
    const checked=await f.machines.checkSSH(host.id,{},"admin",controller.signal);
    assert.equal(checked.discovery.status,"unavailable",action);
    assert.equal(f.db.all("SELECT * FROM machine_network_observations").length,0,action);
    if(action==="target")assert.equal(checked.error_code,"host_key_mismatch");
    if(action==="cancel")assert.equal(checked.error_code,"cancelled");
  }
});

test("user rename preserves SSH identity, discovery and reusable preflight while plans require review under the new name",async t=>{
  const f=await machineFixture(t,async()=>({stdout:core+block(),stderr:"",stages:[]}));
  const host=await f.create(), other=await f.create();
  const checked=await f.request(`/machines/${host.id}/ssh-check`,"POST",{});
  const plan=await f.request(`/machines/${host.id}/deployments/plan`,"POST",{check_id:checked.id,version:"0.1.0",arch:"amd64"});
  const before=f.machines.get(host.id), beforeCheck=f.db.get("SELECT * FROM machine_ssh_checks WHERE id=?",checked.id);
  const renamed=await f.request(`/machines/${host.id}`,"PUT",{name:"Custom production label"});
  assert.equal(renamed.id,host.id);assert.equal(renamed.name,"Custom production label");
  for(const field of ["address","port","username","host_key_fingerprint","ssh_target_generation"] as const)assert.equal(renamed[field],before[field],field);
  assert.deepEqual(renamed.network,before.network);assert.equal(renamed.network.hostname,"fixture-db");
  assert.deepEqual(f.db.get("SELECT * FROM machine_ssh_checks WHERE id=?",checked.id),beforeCheck);
  assert.equal(f.db.get<any>("SELECT status FROM machine_deployments WHERE id=?",plan.id)!.status,"cancelled");
  const revised=await f.request(`/machines/${host.id}/deployments/plan`,"POST",{check_id:checked.id,version:"0.1.0",arch:"amd64"});
  assert.equal(revised.plan.machine.name,"Custom production label");assert.equal(revised.plan.machine.id,host.id);
  // Matching names, SSH endpoints, fingerprints or system hostnames are never
  // asset identity: another registered record must stay separate.
  const otherChecked=await f.request(`/machines/${other.id}/ssh-check`,"POST",{});
  assert.equal(otherChecked.discovery.hostname,renamed.network.hostname);
  assert.equal(f.machines.get(other.id).name,"User configured name");
  assert.notEqual(host.id,other.id);assert.equal(f.db.all("SELECT machine_id FROM machine_network_observations").length,2);
});

test("connection edits invalidate only the changed host and returning to the old target does not resurrect an SSH snapshot",async t=>{
  for(const [field,value] of [["address","next.fixture"],["port",2222],["username","otherlogin"]] as const){
    const f=await machineFixture(t,async()=>({stdout:core+block(),stderr:"",stages:[]})),host=await f.create();
    const checked=await f.request(`/machines/${host.id}/ssh-check`,"POST",{}),before=f.machines.get(host.id);
    const changed=await f.request(`/machines/${host.id}`,"PUT",{[field]:value});
    assert.equal(changed.id,host.id);assert.equal(changed.name,before.name);assert.equal(changed.ssh_target_generation,before.ssh_target_generation+1);
    assert.equal(changed.network.observed_via,"unavailable");assert.equal(changed.network.hostname,"");assert.deepEqual(changed.network.private_ips,[]);
    assert.equal(f.db.get("SELECT id FROM machine_ssh_checks WHERE id=?",checked.id),undefined);
    assert.equal(changed.host_key_fingerprint,field==="username"?before.host_key_fingerprint:"");
    const returned=await f.request(`/machines/${host.id}`,"PUT",{[field]:before[field]});
    assert.equal(returned.network.observed_via,"unavailable",field);assert.equal(returned.network.hostname,"");
  }
});

test("real loopback SSH uses one authenticated exec and bounded fixed discovery, with private key and password",async t=>{
  const key=fixturePrivateKey(),parsed=ssh2.utils.parseKey(key);
  if(parsed instanceof Error||Array.isArray(parsed))throw Error("fixture key invalid");
  const fingerprint="SHA256:"+createHash("sha256").update(parsed.getPublicSSH()).digest("base64").replace(/=+$/,"");
  const password=randomBytes(24).toString("base64url"),commands:string[]=[],connections=new Set<any>();
  const directory=mkdtempSync(join(tmpdir(),"lightmoni-discovery-ssh-"));
  let json=JSON.stringify(brief),keyAuth="";
  const quote=(value:string)=>"'"+value.replace(/'/g,"'\\''")+"'";
  writeFileSync(join(directory,"timeout"),'#!/bin/sh\nshift\nexec "$@"\n',{mode:0o700});
  writeFileSync(join(directory,"uname"),"#!/bin/sh\ncase $1 in -n) echo fixture-ssh;; -s) echo Linux;; -m) echo aarch64;; esac\n",{mode:0o700});
  writeFileSync(join(directory,"curl"),"#!/bin/sh\nexit 0\n",{mode:0o700});
  const server=new ssh2.Server({hostKeys:[key]},client=>{
    connections.add(client);client.on("close",()=>connections.delete(client));client.on("error",()=>{});
    client.on("authentication",context=>{
      if(context.method==="password"&&context.username==="fixture"&&context.password===password)context.accept();
      else if(context.method==="publickey"&&context.username==="fixture"&&context.key.data.toString("base64")===keyAuth)context.accept();
      else context.reject(["password","publickey"]);
    });
    client.on("ready",()=>client.on("session",accept=>accept().on("exec",(accept,_reject,info)=>{
      commands.push(info.command);const channel=accept();
      writeFileSync(join(directory,"ip"),`#!/bin/sh\n[ "$*" = '-j -brief address show' ] || exit 1\nprintf '%s\\n' ${quote(json)}\n`,{mode:0o700});
      // Only this isolated fixture replaces the fixed PATH with deterministic
      // tools. Production sends exactly the platform-owned preflight script.
      const script=info.command.replace(/^PATH=[^;]+;/,`PATH=${quote(directory+":/usr/bin:/bin")};`);
      execFile("sh",["-c",script],{encoding:"utf8",timeout:10_000,maxBuffer:12_000},(error,stdout,stderr)=>{
        channel.write(stdout);channel.stderr.write(stderr);channel.exit(error?1:0);channel.end();
      });
    })));
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  t.after(async()=>{for(const client of connections)client.end();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});});
  const port=(server.address() as any).port;
  const f=await machineFixture(t);
  const host=await f.create({address:"127.0.0.1",port,pin:fingerprint,password});
  const first=await f.request(`/machines/${host.id}/ssh-check`,"POST",{});
  assert.equal(first.connected,true);assert.equal(first.discovery.status,"succeeded");assert.equal(first.discovery.hostname,"fixture-ssh");
  assert.equal(commands.length,1);assert.equal(commands[0],preflightCommand("https://platform.fixture"));assert.ok(!commands[0].includes(password));
  // The ssh2 transport retains only the last 12KB; the producer must enforce
  // its own smaller optional bound so oversized metadata cannot remove core.
  json="x".repeat(30_000);f.advance();
  const excessive=await f.request(`/machines/${host.id}/ssh-check`,"POST",{});
  assert.equal(excessive.connected,true);assert.equal(excessive.checks.linux,true);assert.equal(excessive.discovery.status,"unavailable");
  assert.equal((await f.request(`/machines/${host.id}`)).machine.network.hostname,"fixture-ssh");
  const keyHost=await f.create({address:"127.0.0.1",port,pin:fingerprint,method:"ssh_key"});
  const material=f.db.get<any>("SELECT c.secret_encrypted FROM effective_machine_credentials c WHERE id=?",keyHost.credentialID)!;
  const keyValue=JSON.parse(cipher(Buffer.alloc(32,19)).decrypt(material.secret_encrypted)).secret;
  const keyParsed=ssh2.utils.parseKey(keyValue);if(keyParsed instanceof Error||Array.isArray(keyParsed))throw Error("fixture auth key invalid");
  keyAuth=keyParsed.getPublicSSH().toString("base64");json=JSON.stringify(brief);
  const withKey=await f.request(`/machines/${keyHost.id}/ssh-check`,"POST",{});
  assert.equal(withKey.connected,true);assert.equal(withKey.discovery.status,"succeeded");assert.equal(commands.length,3);
});
