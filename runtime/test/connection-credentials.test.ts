import {test} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {once} from "node:events";
import ssh2 from "ssh2";
import {DB} from "../src/shared/sqlite.js";
import {cipher} from "../src/shared/crypto.js";
import {Router,fail} from "../src/shared/http.js";
import {registerManagedMachines} from "../src/server/managed-machines.js";
import type {Dependencies} from "../src/shared/types.js";
import {fixturePrivateKey} from "./helpers/ssh-key.js";

const output="LMSSH=1\nplatform=linux\narch=amd64\nlinux=1\nsupported_arch=1\ncurl=1\ntar=1\ngzip=1\nsha256sum=1\nsystemd=1\nprivilege_state=root\ninstall_privilege=1\nplatform_https=1\nagent_installation=absent\n";
async function fixture(t:any) {
  const db=new DB(":memory:"),router=new Router(),encryption=cipher(Buffer.alloc(32,71));
  let clock=new Date("2026-10-30T00:00:00.000Z"),calls:any[]=[];
  const user={id:"admin",role:"admin",name:"Admin"};
  db.exec("CREATE TABLE agents(id TEXT PRIMARY KEY,last_seen TEXT NOT NULL DEFAULT '')");
  const deps={db,router,...encryption,now:()=>clock,auth:{user:()=>user,requireAdmin:(ctx:any)=>{if(ctx.user.role!=="admin")fail(403,"administrator required")}},externalURL:"https://monitor.example.test",logger:{info(){},warn(){},error(){}}} as unknown as Dependencies;
  const machines=registerManagedMachines(deps,{sshRunner:async input=>{calls.push(input);return {stdout:output,stderr:"",stages:[]}}});
  router.auth=deps.auth;
  const server=createServer(async(req,res)=>{if(!await router.handle(req,res)){res.writeHead(404);res.end()}});
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const url=`http://127.0.0.1:${(server.address() as any).port}/api/v1`;
  t.after(()=>{machines.close?.();server.close();db.close()});
  const request=async(path:string,method="GET",body?:any)=>{const response=await fetch(url+path,{method,headers:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});const raw=await response.text();return {status:response.status,raw,data:JSON.parse(raw)}};
  const host=async(name:string)=>{const response=await request("/machines","POST",{name,address:name+".example.test",username:"deploy"});assert.equal(response.status,201,response.raw);db.run("UPDATE managed_machines SET host_key_fingerprint='SHA256:fixture-confirmed-key' WHERE id=?",response.data.id);return response.data.id as string};
  const key=async(secret=fixturePrivateKey(),extra:any={})=>{const response=await request("/connection-credentials","POST",{name:"Shared deploy key",method:"ssh_key",secret,retention:"managed",confirm_managed:true,...extra});assert.equal(response.status,201,response.raw);return response.data};
  const bind=async(mid:string,cid:string)=>{const response=await request(`/machines/${mid}/credentials`,"POST",{connection_credential_id:cid});assert.equal(response.status,201,response.raw);return response.data};
  return {db,deps,user,machines,request,host,key,bind,calls,advance:(ms:number)=>{clock=new Date(clock.getTime()+ms)}};
}

test("vault deduplicates actual SSH public keys, never extends retention, and never exposes encrypted material",async t=>{
  const f=await fixture(t),secret=fixturePrivateKey(),first=await f.key(secret),second=await f.key(secret+"\n",{name:"A different label",retention:"permanent",confirm_managed:undefined,confirm_permanent:true});
  assert.equal(first.reused,false);assert.equal(second.reused,true);assert.equal(second.id,first.id);assert.equal(second.expires_at,first.expires_at);assert.equal(second.retention,"managed");assert.equal(second.name,first.name);assert.match(first.secret_fingerprint,/^SHA256:/);
  const listed=await f.request("/connection-credentials");assert.equal(listed.status,200);assert.equal(listed.data.length,1);assert.ok(!listed.raw.includes(secret));assert.ok(!listed.raw.includes("secret_encrypted"));assert.ok(!listed.raw.includes("PRIVATE KEY"));
  const renamed=await f.request(`/connection-credentials/${first.id}`,"PUT",{name:"Production deploy"});assert.equal(renamed.data.name,"Production deploy");
  assert.equal((await f.request("/connection-credentials","POST",{name:"Invalid",method:"ssh_key",secret:"-----BEGIN PRIVATE KEY----- junk",confirm_managed:true})).status,400);
  const encrypted=ssh2.utils.generateKeyPairSync("ed25519",{passphrase:"fixture-passphrase",cipher:"aes256-cbc"});
  const rejected=await f.request("/connection-credentials","POST",{name:"Encrypted",method:"ssh_key",secret:encrypted.private,confirm_managed:true});assert.equal(rejected.status,400);assert.ok(!rejected.raw.includes("fixture-passphrase"));
});

test("one vault secret binds multiple hosts with automatic default selection; detaching and deleting a host preserve the shared source",async t=>{
  const f=await fixture(t),a=await f.host("first"),b=await f.host("second"),secret=fixturePrivateKey(),key=await f.key(secret),one=await f.bind(a,key.id),two=await f.bind(b,key.id);
  assert.notEqual(one.credential_id,two.credential_id);assert.equal(f.machines.get(a).default_credential_id,one.credential_id);
  const bindings=f.db.all<any>("SELECT * FROM machine_credentials");assert.ok(bindings.every(value=>!("secret_encrypted" in value)));assert.equal(f.db.all("SELECT * FROM connection_credentials").length,1);
  const checked=await f.request(`/machines/${a}/ssh-check`,"POST",{});assert.equal(checked.status,200,checked.raw);assert.equal(checked.data.credential_id,one.credential_id);assert.equal(f.calls[0].privateKey,secret.trim());
  const detail=await f.request(`/machines/${a}`);assert.equal(detail.data.credentials[0].connection_credential_id,key.id);assert.equal(detail.data.credentials[0].is_default,1);
  assert.equal((await f.request(`/machines/${a}/credentials/${one.credential_id}`,"DELETE")).status,200);
  assert.equal((await f.request(`/machines/${a}`,"DELETE")).status,200);
  const listed=await f.request("/connection-credentials");assert.equal(listed.data[0].status,"active");assert.deepEqual(listed.data[0].hosts,[{id:b,name:"second"}]);
  assert.equal((await f.request(`/machines/${b}/ssh-check`,"POST",{})).data.ready,true);
});

test("manual entry honors its requested six-hour lifetime even when reusing a permanently stored key",async t=>{
  const f=await fixture(t),a=await f.host("permanent-source"),b=await f.host("finite-binding"),secret=fixturePrivateKey();
  const source=await f.key(secret,{retention:"permanent",confirm_managed:undefined,confirm_permanent:true});await f.bind(a,source.id);
  const added=await f.request(`/machines/${b}/credentials`,"POST",{method:"ssh_key",secret,confirm_managed:true});assert.equal(added.status,201,added.raw);assert.equal(added.data.reused,true);assert.equal(added.data.retention,"managed");assert.equal(added.data.expires_at,"2026-10-30T06:00:00.000Z");
  const shortened=await f.request(`/machines/${b}/credentials`,"POST",{method:"ssh_key",secret,retention:"managed",confirm_managed:true,expires_in_seconds:60});assert.equal(shortened.data.credential_id,added.data.credential_id);assert.equal(shortened.data.expires_at,"2026-10-30T00:01:00.000Z");
  f.advance(61_000);assert.equal(f.machines.get(b).active_credential_count,0);assert.equal(f.machines.get(a).active_credential_count,1);assert.equal(f.db.get<any>("SELECT expires_at FROM connection_credentials WHERE id=?",source.id)?.expires_at,"");
});

test("global revocation invalidates active terminals and pending plans on every bound host without falling back",async t=>{
  const f=await fixture(t),a=await f.host("revoke-first"),b=await f.host("revoke-second"),key=await f.key(),one=await f.bind(a,key.id),two=await f.bind(b,key.id);
  const checked=await f.request(`/machines/${a}/ssh-check`,"POST",{});
  const plan=await f.request(`/machines/${a}/deployments/plan`,"POST",{check_id:checked.data.id,credential_id:one.credential_id,version:"0.1.0",arch:"amd64"});assert.equal(plan.status,201,plan.raw);
  let disconnected=false;const lease=f.machines.acquireTerminal(b,undefined,()=>{disconnected=true;lease.release()});assert.equal(lease.valid(),true);
  assert.equal((await f.request(`/connection-credentials/${key.id}/revoke`,"POST",{})).status,400);
  const revoked=await f.request(`/connection-credentials/${key.id}/revoke`,"POST",{confirm:true});assert.equal(revoked.status,200,revoked.raw);assert.equal(revoked.data.affected_hosts.length,2);assert.equal(disconnected,true);assert.equal(lease.valid(),false);
  assert.equal(f.db.get<any>("SELECT secret_encrypted FROM connection_credentials WHERE id=?",key.id)?.secret_encrypted,"");
  assert.equal(f.db.get<any>("SELECT status FROM machine_deployments WHERE id=?",plan.data.id)?.status,"cancelled");
  for(const mid of [a,b]){assert.equal(f.machines.get(mid).capabilities.terminal.available,false);assert.equal((await f.request(`/machines/${mid}/ssh-check`,"POST",{})).status,409)}
  assert.equal(f.machines.get(b).default_credential_id,two.credential_id);
});

test("vault expiration clears source material and all bindings; expired default does not switch to another active binding",async t=>{
  const f=await fixture(t),mid=await f.host("expiry"),long=await f.key(fixturePrivateKey(),{expires_in_seconds:3600}),short=await f.key(fixturePrivateKey(),{expires_in_seconds:60});
  const other=await f.bind(mid,long.id),preferred=await f.bind(mid,short.id);let invalidated=false;
  const lease=f.machines.acquireTerminal(mid,undefined,()=>{invalidated=true;lease.release()});f.advance(61_000);
  assert.equal(f.machines.get(mid).default_credential_id,preferred.credential_id);assert.equal(invalidated,true);assert.equal(lease.valid(),false);
  assert.equal((await f.request(`/machines/${mid}/ssh-check`,"POST",{})).status,409);
  assert.equal((await f.request(`/machines/${mid}/default-credential`,"PUT",{credential_id:other.credential_id})).status,200);
  assert.equal((await f.request(`/machines/${mid}/ssh-check`,"POST",{})).data.ready,true);
  assert.equal(f.db.get<any>("SELECT secret_encrypted FROM connection_credentials WHERE id=?",short.id)?.secret_encrypted,"");
});

test("passwords preserve whitespace and are never deduplicated or hashed; all vault actions require administrator",async t=>{
  const f=await fixture(t),mid=await f.host("password"),secret="  same password\t";
  const create=()=>f.request("/connection-credentials","POST",{name:"Password",method:"password",secret,confirm_managed:true});
  const a=await create(),b=await create();assert.equal(a.status,201,a.raw);assert.equal(b.status,201,b.raw);assert.notEqual(a.data.id,b.data.id);assert.equal(a.data.secret_fingerprint,"");
  await f.bind(mid,a.data.id);assert.equal((await f.request(`/machines/${mid}/ssh-check`,"POST",{})).data.ready,true);assert.equal(f.calls[0].password,secret);
  f.user.role="member";
  for(const [path,method,body] of [["/connection-credentials","GET",undefined],["/connection-credentials","POST",{}],[`/connection-credentials/${a.data.id}`,"PUT",{name:"No"}],[`/connection-credentials/${a.data.id}/revoke`,"POST",{confirm:true}],[`/machines/${mid}/default-credential`,"PUT",{credential_id:a.data.id}]] as const)assert.equal((await f.request(path,method,body)).status,403);
});

test("one-time password sources cannot be shared or rebound after consumption",async t=>{
  const f=await fixture(t),a=await f.host("single-a"),b=await f.host("single-b");
  const created=await f.request("/connection-credentials","POST",{name:"Single-use login",method:"password",secret:"fixture-once",retention:"one_time"});assert.equal(created.status,201,created.raw);
  await f.bind(a,created.data.id);
  assert.equal((await f.request(`/machines/${b}/credentials`,"POST",{connection_credential_id:created.data.id})).status,409);
  assert.equal((await f.request(`/machines/${a}/ssh-check`,"POST",{})).data.ready,true);
  for(const mid of [a,b])assert.equal((await f.request(`/machines/${mid}/credentials`,"POST",{connection_credential_id:created.data.id})).status,409);
  assert.equal(f.db.get<any>("SELECT secret_encrypted FROM connection_credentials WHERE id=?",created.data.id)?.secret_encrypted,"");
});
