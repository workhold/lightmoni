import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { DB } from "../src/shared/sqlite.js";
import { Router, fail } from "../src/shared/http.js";
import type { Dependencies } from "../src/shared/types.js";
import { McpAccess, registerMcpAccess } from "../src/mcp/access.js";
import { safeReturnTarget } from "../src/server/oauth.js";

async function fixture() {
  const db=new DB(":memory:"),router=new Router(),origin="https://moni.example.test";
  db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,role TEXT,active INTEGER); INSERT INTO users VALUES('admin','Admin','admin',1),('other','Other','admin',1); CREATE TABLE managed_machines(id TEXT PRIMARY KEY); INSERT INTO managed_machines VALUES('one');");
  let now=new Date("2026-10-30T00:00:00.000Z");
  const deps={db,router,externalURL:origin,now:()=>now} as Dependencies;
  deps.auth={user(req:IncomingMessage){const id=req.headers.cookie?.match(/test_user=(admin|other)/)?.[1];return id?db.get<any>("SELECT id,name,role FROM users WHERE id=? AND active=1",id):undefined;},requireAdmin(c:any){if(c.user.role!=="admin")fail(403,"admin required");}} as any;
  router.auth=deps.auth;router.externalURL=origin;
  const access=new McpAccess(deps);registerMcpAccess(deps,access);
  const server=createServer((req,res)=>{void router.handle(req,res).then(found=>{if(!found){res.writeHead(404);res.end();}});});server.listen(0,"127.0.0.1");await once(server,"listening");
  const url="http://127.0.0.1:"+(server.address() as any).port;
  async function api(path:string,body?:any,options:RequestInit={}){
    const response=await fetch(url+path,{method:body===undefined?"GET":"POST",...options,headers:{cookie:"test_user=admin",Origin:origin,...(body!==undefined?{"Content-Type":"application/json"}:{}),...options.headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    return {status:response.status,data:await response.json(),headers:response.headers};
  }
  async function client(redirect="http://127.0.0.1:8123/callback") { const result=await api("/api/v1/mcp-access/clients",{name:"Local Codex",redirect_uris:[redirect]});assert.equal(result.status,201);return result.data; }
  const verifier="v".repeat(64),challenge=createHash("sha256").update(verifier).digest("base64url");
  async function authorize(c:any,overrides:any={}){
    const input={client_id:c.id,redirect_uri:c.redirect_uris[0],response_type:"code",code_challenge:challenge,code_challenge_method:"S256",resource:access.endpoint,state:"random-client-state",scope:"hosts.read tasks.read",...overrides};
    const result=await api("/api/v1/mcp/oauth/approve",{...input,host_ids:["one"],expires_in_hours:24});
    assert.equal(result.status,200,JSON.stringify(result.data));const callback=new URL(result.data.redirect_url);assert.equal(callback.searchParams.get("state"),input.state);assert.equal(callback.searchParams.get("iss"),origin);
    return {...input,code:callback.searchParams.get("code")!};
  }
  async function exchange(input:Record<string,string>,originHeader?:string){
    const response=await fetch(url+"/api/v1/mcp/oauth/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded",...(originHeader?{Origin:originHeader}:{})},body:new URLSearchParams(input)});
    return {status:response.status,data:await response.json(),headers:response.headers};
  }
  async function code(c:any,a:any,extra:any={}){return exchange({grant_type:"authorization_code",client_id:c.id,redirect_uri:a.redirect_uri,resource:access.endpoint,code:a.code,code_verifier:verifier,...extra});}
  return {db,access,api,client,authorize,exchange,code,verifier,challenge,url,origin,advance(minutes:number){now=new Date(now.getTime()+minutes*60_000);},async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();}};
}
const bearer=(raw:string)=>({headers:{authorization:"Bearer "+raw}} as IncomingMessage);

test("OAuth discovery, explicit consent, code/PKCE exchange and refresh produce scoped resource-specific credentials",async()=>{
  const f=await fixture();try{
    const metadata=await f.api("/.well-known/oauth-protected-resource/api/v1/mcp");assert.equal(metadata.data.resource,f.access.endpoint);assert.deepEqual(metadata.data.authorization_servers,[f.origin]);
    const server=await f.api("/.well-known/oauth-authorization-server");assert.deepEqual(server.data.code_challenge_methods_supported,["S256"]);assert.equal(server.data.registration_endpoint,undefined);
    const c=await f.client(),a=await f.authorize(c);
    const inspected=await f.api("/api/v1/mcp/oauth/request?"+new URLSearchParams(a));assert.equal(inspected.status,200);assert.equal(inspected.data.client.name,"Local Codex");assert.deepEqual(inspected.data.scopes,["hosts.read","tasks.read"]);
    const result=await f.code(c,a);assert.equal(result.status,200);assert.equal(result.data.token_type,"Bearer");assert.equal(result.data.expires_in,900);assert.equal(result.headers.get("cache-control"),"no-store");
    const principal=f.access.authenticate(bearer(result.data.access_token));assert.deepEqual(principal.host_ids,["one"]);assert.deepEqual(principal.scopes,["hosts.read","tasks.read"]);
    assert.throws(()=>f.access.authenticate(bearer(result.data.refresh_token)),/MCP/);
    assert.ok(!JSON.stringify(f.db.all("SELECT * FROM mcp_access_tokens")).includes(result.data.access_token));
    f.advance(16);assert.throws(()=>f.access.authenticate(bearer(result.data.access_token)),/失效/);assert.equal(f.access.validateGrant(principal.grant_id).user.id,"admin");
    const refresh=await f.exchange({grant_type:"refresh_token",client_id:c.id,resource:f.access.endpoint,refresh_token:result.data.refresh_token});assert.equal(refresh.status,200);assert.notEqual(refresh.data.refresh_token,result.data.refresh_token);assert.equal(f.access.authenticate(bearer(refresh.data.access_token)).grant_id,principal.grant_id);
  }finally{await f.close();}
});

test("OAuth refuses invalid PKCE, audience, foreign clients and callback changes without burning a valid code",async()=>{
  const f=await fixture();try{
    const c=await f.client(),other=await f.client("https://other.example.test/callback"),a=await f.authorize(c);
    for(const extra of [{code_verifier:"z".repeat(64)},{resource:"https://other.example.test/mcp"},{client_id:other.id},{redirect_uri:"http://127.0.0.1:8123/evil"}]){const result=await f.code(c,a,extra);assert.ok(result.status>=400);}
    assert.equal((await f.code(c,a)).status,200);
    const raw=await f.api("/api/v1/mcp/oauth/approve",{client_id:c.id,redirect_uri:c.redirect_uris[0],response_type:"code",code_challenge:f.challenge,code_challenge_method:"plain",resource:f.access.endpoint,state:"s",scope:"hosts.read",host_ids:null});assert.equal(raw.status,400);
    const denied=await f.api("/api/v1/mcp/oauth/approve",{client_id:c.id,redirect_uri:"https://evil.example/callback",response_type:"code",code_challenge:f.challenge,code_challenge_method:"S256",resource:f.access.endpoint,state:"s",scope:"hosts.read",host_ids:null});assert.equal(denied.status,400);
  }finally{await f.close();}
});

test("refresh replay and authorization-code replay revoke the stable grant and all descendant access tokens",async()=>{
  for(const kind of ["refresh","code"]){
    const f=await fixture();try{
      const c=await f.client(),a=await f.authorize(c),first=await f.code(c,a);assert.equal(first.status,200);
      if(kind==="refresh"){
        const next=await f.exchange({grant_type:"refresh_token",client_id:c.id,resource:f.access.endpoint,refresh_token:first.data.refresh_token});assert.equal(next.status,200);
        const replay=await f.exchange({grant_type:"refresh_token",client_id:c.id,resource:f.access.endpoint,refresh_token:first.data.refresh_token});assert.equal(replay.status,400);assert.equal(replay.data.error,"invalid_grant");assert.throws(()=>f.access.authenticate(bearer(next.data.access_token)),/失效/);
      }else{const replay=await f.code(c,a);assert.equal(replay.status,400);assert.equal(replay.data.error,"invalid_grant");}
      assert.throws(()=>f.access.authenticate(bearer(first.data.access_token)),/失效/);
    }finally{await f.close();}
  }
});

test("client/grant revocation and role loss block new exchanges and cached access",async()=>{
  for(const change of ["client","grant","role","expiry"]){
    const f=await fixture();try{
      const c=await f.client(),a=await f.authorize(c),first=await f.code(c,a),p=f.access.authenticate(bearer(first.data.access_token));
      if(change==="client")assert.equal((await f.api("/api/v1/mcp-access/clients/"+c.id,undefined,{method:"DELETE"})).status,200);
      if(change==="grant")assert.equal((await f.api("/api/v1/mcp-access/grants/"+p.grant_id,undefined,{method:"DELETE"})).status,200);
      if(change==="role")f.db.run("UPDATE users SET role='member' WHERE id='admin'");
      if(change==="expiry")f.advance(24*60+1);
      assert.throws(()=>f.access.validate(p));const result=await f.exchange({grant_type:"refresh_token",client_id:c.id,resource:f.access.endpoint,refresh_token:first.data.refresh_token});assert.ok(result.status>=400);
    }finally{await f.close();}
  }
});

test("consent is explicit and same-origin; callbacks allow native port variation but reject different hosts or paths",async()=>{
  const f=await fixture();try{
    const c=await f.client(),a={client_id:c.id,redirect_uri:"http://127.0.0.1:9234/callback",response_type:"code",code_challenge:f.challenge,code_challenge_method:"S256",resource:f.access.endpoint,state:"s",scope:"hosts.read"};
    assert.equal((await f.api("/api/v1/mcp/oauth/request?"+new URLSearchParams(a))).status,200);
    assert.equal((await f.api("/api/v1/mcp/oauth/request?"+new URLSearchParams({...a,redirect_uri:"http://127.0.0.2:9234/callback"}))).status,400);
    assert.equal((await f.api("/api/v1/mcp/oauth/request?"+new URLSearchParams({...a,redirect_uri:"http://127.0.0.1:9234/elsewhere"}))).status,400);
    const without=await fetch(f.url+"/api/v1/mcp/oauth/approve",{method:"POST",headers:{cookie:"test_user=admin","Content-Type":"application/json"},body:JSON.stringify({...a,host_ids:null})});assert.equal(without.status,403);
    const foreign=await f.api("/api/v1/mcp/oauth/approve",{...a,host_ids:null},{headers:{Origin:"https://evil.example"}});assert.equal(foreign.status,403);
    const start=await fetch(f.url+"/api/v1/mcp/oauth/authorize?"+new URLSearchParams(a),{redirect:"manual"});assert.equal(start.status,302);assert.ok(start.headers.get("location")?.startsWith(f.origin+"/mcp/authorize?"));
    assert.equal(f.db.get<any>("SELECT count(*) n FROM mcp_oauth_codes")!.n,0);
  }finally{await f.close();}
});

test("management API limits secrets to creation and enforces ownership, JSON limits and registered redirects",async()=>{
  const f=await fixture();try{
    const made=await f.api("/api/v1/mcp-access/tokens",{name:"Codex",scopes:["hosts.read"],host_ids:null});assert.equal(made.status,201);assert.ok(made.data.token);
    const list=await f.api("/api/v1/mcp-access");assert.equal(list.status,200);assert.equal(list.headers.get("cache-control"),"no-store");assert.equal(list.data.tokens.length,1);assert.ok(!JSON.stringify(list.data).includes(made.data.token));
    const other=await f.api("/api/v1/mcp-access/tokens/"+made.data.id,undefined,{method:"DELETE",headers:{cookie:"test_user=other"}});assert.equal(other.status,404);
    assert.equal((await f.api("/api/v1/mcp-access/tokens/"+made.data.id,undefined,{method:"DELETE"})).status,200);assert.throws(()=>f.access.authenticate(bearer(made.data.token)),/失效/);
    const malformed=await fetch(f.url+"/api/v1/mcp-access/tokens",{method:"POST",headers:{cookie:"test_user=admin",Origin:f.origin,"Content-Type":"application/json"},body:"{"});assert.equal(malformed.status,400);
    for(const redirect of ["http://external.example/callback","http://127.0.0.1/callback","https://user:password@example.test/callback","https://example.test/callback#fragment"]){assert.ok((await f.api("/api/v1/mcp-access/clients",{name:"Bad",redirect_uris:[redirect]})).status>=400);}
    const c=await f.client("https://client.example.test/callback"),a=await f.authorize(c);
    const unknown=await f.exchange({grant_type:"authorization_code",client_id:c.id,redirect_uri:a.redirect_uri,resource:f.access.endpoint,code:a.code,code_verifier:f.verifier},"https://evil.example");assert.equal(unknown.status,403);
    const good=await f.exchange({grant_type:"authorization_code",client_id:c.id,redirect_uri:a.redirect_uri,resource:f.access.endpoint,code:a.code,code_verifier:f.verifier},"https://client.example.test");assert.equal(good.status,200);assert.equal(good.headers.get("access-control-allow-origin"),"https://client.example.test");
  }finally{await f.close();}
});


test("platform SSO return target preserves the exact MCP consent page without broadening redirect permissions",()=>{
  assert.equal(safeReturnTarget("/mcp/authorize?client_id=local&state=opaque&resource=https%3A%2F%2Fmoni.example.test%2Fapi%2Fv1%2Fmcp"),true);
  for(const target of ["https://evil.example/mcp/authorize","//evil.example/mcp/authorize","/mcp/authorize-evil","/mcp/authorize/elsewhere","/mcp/authorize%2Fevil","/mcp/authorize#https://evil.example","/mcp\\authorize","/mcp/authorize\n"])assert.equal(safeReturnTarget(target),false,target);
});
