import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { DB } from "../src/shared/sqlite.js";
import type { Dependencies } from "../src/shared/types.js";
import { McpAccess } from "../src/mcp/access.js";
import { registerMcpClient } from "../src/mcp/oauth.js";
const request = (value?:string) => ({headers:value?{authorization:"Bearer "+value}:{cookie:"lm_session=browser-session"}} as IncomingMessage);
function fixture(externalURL="https://moni.example.test") {
  const db=new DB(":memory:");db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,role TEXT,active INTEGER); INSERT INTO users VALUES('admin','Admin','admin',1),('member','Member','member',1); CREATE TABLE managed_machines(id TEXT PRIMARY KEY); INSERT INTO managed_machines VALUES('one'),('two');");
  let now=new Date("2026-10-30T00:00:00.000Z");
  const deps={db,externalURL,now:()=>now} as Dependencies;
  const access=new McpAccess(deps),user={id:"admin",name:"Admin",role:"admin"};
  return {db,access,user,advance(minutes:number){now=new Date(now.getTime()+minutes*60_000);}};
}

test("MCP PAT has isolated bearer authentication and stores only one-way hashes",()=>{
  const f=fixture();try{
    const key=f.access.createToken(f.user,{name:"Codex",scopes:["hosts.read","tasks.read"],host_ids:["one"]});
    assert.match(key.token,/^lm_pat_[A-Za-z0-9_-]{43}$/);
    const principal=f.access.authenticate(request(key.token));
    assert.deepEqual(principal.host_ids,["one"]);assert.equal(principal.user.id,"admin");assert.equal(principal.source,"mcp");
    const stored=f.db.all<any>("SELECT * FROM mcp_access_tokens");assert.ok(stored[0].token_hash);assert.ok(!JSON.stringify(stored).includes(key.token));
    assert.ok(!JSON.stringify(f.access.summary(f.user)).includes(key.token));
    for(const raw of [undefined,"lm_"+"a".repeat(43),"control-credential",key.token+"tail", "lm_ort_"+"a".repeat(43)])assert.throws(()=>f.access.authenticate(request(raw)),/MCP/);
  }finally{f.db.close();}
});

test("PAT scope and host grant cannot be widened through unknown parameters or missing targets",()=>{
  const f=fixture();try{
    assert.throws(()=>f.access.createToken(f.user,{name:"Bad",scopes:["*"],host_ids:null}),/授权/);
    assert.throws(()=>f.access.createToken(f.user,{name:"Bad",scopes:["hosts.read"],host_ids:["unknown"]}),/不可用/);
    assert.throws(()=>f.access.createToken(f.user,{name:"Bad",scopes:["hosts.read"]}),/主机/);
    assert.throws(()=>f.access.createToken(f.user,{name:"Bad",scopes:["hosts.read"],host_ids:null,user_id:"member"}),/参数/);
    assert.throws(()=>f.access.createToken({id:"member",name:"Member",role:"admin"},{name:"Bad",scopes:["hosts.read"],host_ids:null}),/授权/);
    for(const lifetime of [0,8761,1.5,"24",null])assert.throws(()=>f.access.lifetime(lifetime),/期限/);
    const key=f.access.createToken(f.user,{name:"No hosts",scopes:["hosts.read"],host_ids:[]});assert.deepEqual(f.access.authenticate(request(key.token)).host_ids,[]);
  }finally{f.db.close();}
});

test("authentication and validation refresh scope, targets, current role and account state",()=>{
  const f=fixture();try{
    const key=f.access.createToken(f.user,{name:"Codex",scopes:["hosts.read","tasks.read"],host_ids:null}),p=f.access.authenticate(request(key.token));
    p.scopes.push("tasks.propose");p.host_ids=["two"];p.user.role="admin";
    f.access.validate(p);assert.deepEqual(p.scopes,["hosts.read","tasks.read"]);assert.equal(p.host_ids,null);
    f.db.run("UPDATE mcp_access_grants SET scopes_json=?,host_ids_json=? WHERE id=?",JSON.stringify(["hosts.read"]),JSON.stringify(["one"]),key.grant_id);
    f.access.validate(p);assert.deepEqual(p.scopes,["hosts.read"]);assert.deepEqual(p.host_ids,["one"]);
    f.db.run("UPDATE users SET role='member' WHERE id='admin'");assert.throws(()=>f.access.validate(p),/权限已变化/);assert.throws(()=>f.access.authenticate(request(key.token)),/权限已变化/);
    f.db.run("UPDATE users SET role='admin',active=0 WHERE id='admin'");assert.throws(()=>f.access.sessionPrincipal(f.user,"assistant"),/失效/);
  }finally{f.db.close();}
});

test("expiry, grant revocation and resource changes invalidate cached MCP principals",()=>{
  for(const change of ["expire","revoke","audience","disable"]){
    const f=fixture();try{
      const key=f.access.createToken(f.user,{name:"Codex",scopes:["hosts.read"],host_ids:null,expires_in_hours:1}),p=f.access.authenticate(request(key.token));
      if(change==="expire")f.advance(61);
      if(change==="revoke")f.access.revokeToken(f.user,key.id);
      if(change==="audience")f.db.run("UPDATE mcp_access_grants SET resource='https://other.example/mcp' WHERE id=?",key.grant_id);
      if(change==="disable")f.db.run("UPDATE users SET active=0 WHERE id='admin'");
      assert.throws(()=>f.access.authenticate(request(key.token)),/失效/);assert.throws(()=>f.access.validate(p),/失效/);
    }finally{f.db.close();}
  }
});

test("stable grants outlive short OAuth access tokens, but cannot outlive user revocation",()=>{
  const f=fixture();try{
    const grant=f.access.grant(f.user,"oauth","Local client",["tasks.propose"],["one"],24),issued=f.access.issue(grant,"access",15*60_000);
    const p=f.access.authenticate(request(issued.token));f.advance(16);
    assert.throws(()=>f.access.validate(p),/失效/);assert.equal(f.access.validateGrant(grant.id,f.user.id).user.id,"admin");
    f.access.revokeGrant(f.user,grant.id);assert.throws(()=>f.access.validateGrant(grant.id,f.user.id),/失效/);
  }finally{f.db.close();}
});

test("grant management is owner-bound and external MCP URL never derives from an incoming Host",()=>{
  const f=fixture();try{
    const key=f.access.createToken(f.user,{name:"Codex",scopes:["hosts.read"],host_ids:null});
    assert.throws(()=>f.access.revokeToken({id:"member",name:"Member",role:"member"},key.id),/不存在/);
    assert.throws(()=>f.access.revokeGrant({id:"member",name:"Member",role:"member"},key.grant_id),/不存在/);
    assert.equal(f.access.summary(f.user).endpoint,"https://moni.example.test/api/v1/mcp");
    const local=fixture("http://127.0.0.1:18080");local.db.close();
    for(const url of ["http://external.example","https://user:pass@example.test","https://example.test/prefix","https://example.test/?token=value"]){const bad=fixture();assert.throws(()=>new McpAccess({...bad.access.deps,externalURL:url}),/externalURL/);bad.db.close();}
  }finally{f.db.close();}
});


test("active credentials and clients remain manageable when newer revoked history exceeds page limits",()=>{
  const f=fixture();try{
    const old=f.access.createToken(f.user,{name:"Old active PAT",scopes:["hosts.read"],host_ids:null});
    const grant=f.access.grant(f.user,"oauth","Old active OAuth",["hosts.read"],null,168);
    const client=registerMcpClient(f.access,f.user,{name:"Old active client",redirect_uris:["https://client.example/callback"]});
    for(let i=0;i<205;i++){
      f.advance(1);
      const newer=f.access.createToken(f.user,{name:"Revoked "+i,scopes:["hosts.read"],host_ids:null});
      f.access.revokeToken(f.user,newer.id);
      if(i<105){
        const c=registerMcpClient(f.access,f.user,{name:"Revoked client "+i,redirect_uris:["https://client.example/callback"]});
        f.db.run("UPDATE mcp_oauth_clients SET revoked_at=? WHERE id=?",f.access.now(),c.id);
      }
    }
    const summary=f.access.summary(f.user);
    assert.equal(summary.tokens.length,200);assert.equal(summary.tokens[0].id,old.id);assert.equal(summary.tokens[0].active,true);
    assert.ok(summary.grants.some(g=>g.id===grant.id&&g.active));
    assert.equal(summary.clients.length,100);assert.equal(summary.clients[0].id,client.id);
  }finally{f.db.close();}
});
