import { createHash, randomUUID } from "node:crypto";
import type { Context, Dependencies, User } from "../shared/types.js";
import { hash, token } from "../shared/crypto.js";
import { checkRequestOrigin, HTTPError, fail } from "../shared/http.js";
import { accessObject, type AccessGrant, type McpAccess } from "./access.js";

interface OAuthClient { id:string; user_id:string; name:string; redirect_uris_json:string; revoked_at:string }
interface AuthorizationRequest { client_id:string; redirect_uri:string; response_type:string; code_challenge:string; code_challenge_method:string; resource:string; state:string; scope:string }
class OAuthError extends Error { constructor(readonly code:string, message:string, readonly status=400) { super(message); } }
const invalid = (message="OAuth 请求无效"): never => { throw new OAuthError("invalid_request",message); };
const parseURL = (raw:unknown): URL => {
  if (typeof raw !== "string" || raw.length > 2048) return invalid("无效的回调地址");
  try { const u=new URL(raw); if (u.username||u.password||u.hash) return invalid("回调地址不能包含凭据或片段"); return u; } catch { return invalid("无效的回调地址"); }
};
const local = (u: URL) => ["127.0.0.1","[::1]"].includes(u.hostname);
function registeredRedirect(raw:unknown): string {
  const u=parseURL(raw);
  if (u.protocol!=="https:" && !(u.protocol==="http:"&&local(u)&&!!u.port)) invalid("回调地址必须为 HTTPS，或带端口的回环 IP HTTP 地址");
  return raw as string;
}
function redirectMatches(actual:string,registered:string): boolean {
  const a=parseURL(actual),r=parseURL(registered);
  if(actual===registered)return true;
  // RFC 8252 permits only the port to vary for native loopback redirects.
  return local(a)&&local(r)&&a.protocol==="http:"&&r.protocol==="http:"&&!!a.port&&!!r.port
    &&a.hostname===r.hostname&&a.pathname===r.pathname&&a.search===r.search;
}
function params(value: URLSearchParams): Record<string,string> {
  const out:Record<string,string>={};
  for(const [key,v] of value) { if(Object.hasOwn(out,key)||v.length>4096)invalid("OAuth 参数重复或过长"); out[key]=v; }
  return out;
}
export function registerMcpClient(access:McpAccess,user:User,input:unknown) {
  const v=accessObject(input,["name","redirect_uris"]);
  if(access.currentUser(user.id).role!=="admin")fail(403,"需要管理员权限");
  if(typeof v.name!=="string"||!v.name.trim()||v.name.length>100||/[\p{Cc}]/u.test(v.name))fail(400,"请填写客户端名称");
  if(!Array.isArray(v.redirect_uris)||!v.redirect_uris.length||v.redirect_uris.length>10)fail(400,"请填写 1 到 10 个回调地址");
  const redirects=[...new Set<string>(v.redirect_uris.map(registeredRedirect))];
  return access.deps.db.transaction(()=>{
    if(access.deps.db.get<{n:number}>("SELECT count(*) n FROM mcp_oauth_clients WHERE user_id=? AND revoked_at=''",user.id)!.n>=50)fail(409,"最多登记 50 个客户端");
    const client={id:"lm_client_"+randomUUID(),name:v.name.trim(),redirect_uris:redirects,created_at:access.now(),revoked_at:""};
    access.deps.db.run("INSERT INTO mcp_oauth_clients(id,user_id,name,redirect_uris_json,created_at) VALUES(?,?,?,?,?)",client.id,user.id,client.name,JSON.stringify(redirects),client.created_at);
    return client;
  });
}
function client(access:McpAccess,id:unknown):OAuthClient {
  if(typeof id!=="string"||id.length>128)invalid("未知客户端");
  const found=access.deps.db.get<OAuthClient>("SELECT * FROM mcp_oauth_clients WHERE id=? AND revoked_at=''",id);
  if(!found)invalid("未知或已撤销的客户端");
  return found!;
}
function request(access:McpAccess,input:Record<string,any>,user?:User) {
  const c=client(access,input.client_id); parseURL(input.redirect_uri); const redirect=input.redirect_uri as string;
  if(!(JSON.parse(c.redirect_uris_json) as string[]).some(r=>redirectMatches(redirect,r)))invalid("回调地址未登记");
  if(input.response_type!=="code")throw new OAuthError("unsupported_response_type","仅支持授权码流程");
  if(input.resource!==access.endpoint)throw new OAuthError("invalid_target","必须指定准确的 MCP resource");
  if(input.code_challenge_method!=="S256"||typeof input.code_challenge!=="string"||!/^[-_A-Za-z0-9]{43}$/.test(input.code_challenge))invalid("必须使用 PKCE S256");
  if(typeof input.state!=="string"||!input.state||input.state.length>2048||/[\p{Cc}]/u.test(input.state))invalid("必须提供有效的 OAuth state");
  if(typeof input.scope!=="string"||!input.scope.trim()||input.scope.length>1000)throw new OAuthError("invalid_scope","必须指定请求能力");
  const scopes=input.scope.split(" ");
  if(scopes.some(s=>!s)||new Set(scopes).size!==scopes.length)throw new OAuthError("invalid_scope","无效的请求能力");
  if(user) {
    try { access.selection(user,scopes,null); } catch { throw new OAuthError("invalid_scope","账户不能授予所请求能力",403); }
  }
  const r:AuthorizationRequest={client_id:c.id,redirect_uri:redirect,response_type:"code",code_challenge:input.code_challenge,code_challenge_method:"S256",resource:access.endpoint,state:input.state,scope:scopes.join(" ")};
  return {client:{id:c.id,name:c.name,redirect_uris:JSON.parse(c.redirect_uris_json)},request:r,scopes,endpoint:access.endpoint};
}
const secureResponse = (c:Context) => { c.res.setHeader("cache-control","no-store");c.res.setHeader("pragma","no-cache");c.res.setHeader("referrer-policy","no-referrer"); };
const oauthRoute = (fn:(c:Context)=>unknown|Promise<unknown>) => async(c:Context) => {
  secureResponse(c);
  try { await fn(c); } catch(error) {
    if(error instanceof OAuthError)c.json({error:error.code,error_description:error.message},error.status);
    else if(error instanceof HTTPError)c.json({error:"invalid_request",error_description:error.message},error.status);
    else throw error;
  }
};
async function json(c:Context,limit=16<<10):Promise<unknown> {
  try{return JSON.parse((await c.raw(limit)).toString());}catch(error){if(error instanceof HTTPError)throw error;return invalid("无效的 JSON 请求");}
}
export function registerMcpOAuth(deps:Dependencies,access:McpAccess):void {
  const r=deps.router,base="/api/v1/mcp/oauth";
  const rates=new Map<string,{n:number;until:number}>();
  const rateLimit = (c: Context) => {
    const now=deps.now().getTime(); for(const [key,value] of rates)if(value.until<=now)rates.delete(key);
    const key=hash((c.req.socket.remoteAddress??"unknown")+c.url.pathname),rate=rates.get(key);
    if(rate&&rate.n>=60)throw new OAuthError("temporarily_unavailable","请稍后重试",429);
    if(rate)rate.n++;else { if(rates.size>=4096)throw new OAuthError("temporarily_unavailable","请稍后重试",429); rates.set(key,{n:1,until:now+60_000}); }
  };
  r.get("/.well-known/oauth-protected-resource/api/v1/mcp",c=>{ c.res.setHeader("cache-control","no-store");c.json({resource:access.endpoint,authorization_servers:[access.origin],scopes_supported:CAPABILITY_SCOPES_COPY(access),bearer_methods_supported:["header"],resource_name:"LightMoni MCP"}); },{public:true});
  r.get("/.well-known/oauth-authorization-server",c=>{c.res.setHeader("cache-control","no-store");c.json({issuer:access.origin,authorization_response_iss_parameter_supported:true,authorization_endpoint:access.origin+base+"/authorize",token_endpoint:access.origin+base+"/token",response_types_supported:["code"],grant_types_supported:["authorization_code","refresh_token"],code_challenge_methods_supported:["S256"],token_endpoint_auth_methods_supported:["none"],scopes_supported:CAPABILITY_SCOPES_COPY(access)});},{public:true});
  r.post("/api/v1/mcp-access/clients",oauthRoute(async c=>{c.json(registerMcpClient(access,c.user,await json(c)),201);}));
  r.delete("/api/v1/mcp-access/clients/:id",c=>{
    const row=deps.db.get<{id:string}>("SELECT id FROM mcp_oauth_clients WHERE id=? AND user_id=?",c.params.id,c.user.id);if(!row)fail(404,"客户端不存在");
    deps.db.transaction(()=>{deps.db.run("UPDATE mcp_oauth_clients SET revoked_at=? WHERE id=? AND revoked_at=''",access.now(),row.id);deps.db.run("UPDATE mcp_access_grants SET revoked_at=? WHERE client_id=? AND revoked_at=''",access.now(),row.id);});c.json({ok:true});
  });
  r.get(base+"/authorize",oauthRoute(c=>{
    rateLimit(c); const v=params(c.url.searchParams);request(access,v);
    c.res.writeHead(302,{location:access.origin+"/mcp/authorize?"+new URLSearchParams(v).toString()});c.res.end();
  }),{public:true});
  r.get(base+"/request",oauthRoute(c=>{c.json(request(access,params(c.url.searchParams),c.user));}));
  r.post(base+"/approve",oauthRoute(async c=>{
    rateLimit(c); access.cleanup(); checkRequestOrigin(c.req,access.origin,true);
    const input=accessObject(await json(c),["client_id","redirect_uri","response_type","code_challenge","code_challenge_method","resource","state","scope","host_ids","expires_in_hours"]);
    const validated=request(access,input,c.user),selected=access.selection(c.user,validated.scopes,input.host_ids),hours=access.lifetime(input.expires_in_hours??168);
    const redirect=deps.db.transaction(()=>{
      if(deps.db.get<{n:number}>("SELECT count(*) n FROM mcp_access_grants WHERE user_id=? AND kind='oauth' AND revoked_at='' AND expires_at>?",c.user.id,access.now())!.n>=100)fail(409,"最多保留 100 项有效客户端授权");
      const grant=access.grant(c.user,"oauth",validated.client.name,selected.scopes,selected.host_ids,hours,validated.client.id),code="lm_code_"+token();
      deps.db.run("INSERT INTO mcp_oauth_codes(code_hash,grant_id,client_id,redirect_uri,challenge,resource,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",hash(code),grant.id,grant.client_id,validated.request.redirect_uri,validated.request.code_challenge,access.endpoint,access.now(),new Date(deps.now().getTime()+5*60_000).toISOString());
      const url=new URL(validated.request.redirect_uri);url.searchParams.set("code",code);url.searchParams.set("state",validated.request.state);url.searchParams.set("iss",access.origin);return url.href;
    });
    c.json({redirect_url:redirect});
  }));
  r.post(base+"/token",oauthRoute(async c=>{
    rateLimit(c); access.cleanup();
    if(!/^application\/x-www-form-urlencoded(?:\s*;.*)?$/i.test(c.req.headers["content-type"]??""))invalid("请使用表单编码的 token 请求");
    const v=params(new URLSearchParams((await c.raw(16<<10)).toString()));
    const known=client(access,v.client_id);
    // Native clients usually omit Origin. Browser clients may use only a registered HTTPS redirect origin.
    if(c.req.headers.origin){
      const origin=c.req.headers.origin,allowed=(JSON.parse(known.redirect_uris_json) as string[]).some(u=>{const parsed=new URL(u);return parsed.protocol==="https:"&&parsed.origin===origin;});
      if(!allowed&&origin!==access.origin)throw new OAuthError("invalid_request","无效的请求 Origin",403);
      c.res.setHeader("access-control-allow-origin",origin);c.res.setHeader("vary","Origin");
    }
    if(v.resource!==access.endpoint)throw new OAuthError("invalid_target","必须指定准确的 MCP resource");
    if(v.grant_type!=="authorization_code"&&v.grant_type!=="refresh_token")throw new OAuthError("unsupported_grant_type","不支持的授权方式");
    let failure=false;
    const result=deps.db.transaction(()=>{
      let grant:AccessGrant;
      if(v.grant_type==="authorization_code"){
        if(typeof v.code!=="string"||!/^lm_code_[\w-]{43}$/.test(v.code)||typeof v.code_verifier!=="string"||!/^[A-Za-z0-9._~-]{43,128}$/.test(v.code_verifier))throw new OAuthError("invalid_grant","授权码无效");
        const row=deps.db.get<any>("SELECT * FROM mcp_oauth_codes WHERE code_hash=?",hash(v.code));
        if(!row||row.client_id!==known.id||row.redirect_uri!==v.redirect_uri||row.resource!==access.endpoint||row.expires_at<=access.now()||createHash("sha256").update(v.code_verifier).digest("base64url")!==row.challenge)throw new OAuthError("invalid_grant","授权码无效");
        if(row.used_at){deps.db.run("UPDATE mcp_access_grants SET revoked_at=? WHERE id=? AND revoked_at=''",access.now(),row.grant_id);failure=true;return null;}
        try{access.validateGrant(row.grant_id);}catch{throw new OAuthError("invalid_grant","授权已失效");}
        grant=deps.db.get<AccessGrant>("SELECT * FROM mcp_access_grants WHERE id=?",row.grant_id)!;
        deps.db.run("UPDATE mcp_oauth_codes SET used_at=? WHERE code_hash=? AND used_at=''",access.now(),hash(v.code));
      }else{
        if(typeof v.refresh_token!=="string"||!/^lm_ort_[\w-]{43}$/.test(v.refresh_token))throw new OAuthError("invalid_grant","刷新凭据无效");
        const row=deps.db.get<any>("SELECT t.*,g.client_id,g.resource FROM mcp_access_tokens t JOIN mcp_access_grants g ON g.id=t.grant_id WHERE t.token_hash=? AND t.kind='refresh'",hash(v.refresh_token));
        if(!row||row.client_id!==known.id||row.resource!==access.endpoint||row.expires_at<=access.now()||row.revoked_at)throw new OAuthError("invalid_grant","刷新凭据无效");
        if(row.used_at){deps.db.run("UPDATE mcp_access_grants SET revoked_at=? WHERE id=? AND revoked_at=''",access.now(),row.grant_id);failure=true;return null;}
        try{access.validateGrant(row.grant_id);}catch{throw new OAuthError("invalid_grant","授权已失效");}
        grant=deps.db.get<AccessGrant>("SELECT * FROM mcp_access_grants WHERE id=?",row.grant_id)!;
        if(v.scope&&v.scope!==JSON.parse(grant.scopes_json).join(" "))throw new OAuthError("invalid_scope","刷新不能改变原授权能力");
        deps.db.run("UPDATE mcp_access_tokens SET used_at=? WHERE id=? AND used_at=''",access.now(),row.id);
      }
      const at=access.issue(grant,"access",15*60_000),refresh=access.issue(grant,"refresh");
      return {access_token:at.token,token_type:"Bearer",expires_in:Math.max(0,Math.floor((Date.parse(at.expires_at)-deps.now().getTime())/1000)),refresh_token:refresh.token,scope:JSON.parse(grant.scopes_json).join(" ")};
    });
    if(failure)throw new OAuthError("invalid_grant","检测到已使用凭据，授权已撤销");
    c.json(result);
  }),{public:true});
}
// Keep metadata independent of a logged-in user. Actual authorization always intersects the current role.
import { CAPABILITY_SCOPES } from "../capabilities/types.js";
const CAPABILITY_SCOPES_COPY = (_access:McpAccess) => [...CAPABILITY_SCOPES];
