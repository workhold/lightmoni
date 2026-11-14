import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import type { Dependencies, User } from "../shared/types.js";
import { hash, token } from "../shared/crypto.js";
import { fail, HTTPError } from "../shared/http.js";
import { CAPABILITY_SCOPES, type AccessAuthority, type Principal } from "../capabilities/types.js";
import type { CapabilityDefinition } from "../capabilities/descriptor.js";
import { SessionAccess, scopesForUser } from "../capabilities/access.js";
import { registerMcpOAuth } from "./oauth.js";

export function isMcpExternalURL(raw: string): boolean {
  try {
    const base = new URL(raw);
    return !base.username && !base.password && !base.search && !base.hash && base.pathname === "/"
      && (base.protocol === "https:" || base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname));
  } catch { return false; }
}

export interface AccessGrant {
  id: string; user_id: string; kind: "pat" | "oauth" | "service"; client_id: string; name: string;
  resource: string; scopes_json: string; host_ids_json: string; issued_role: string;
  created_at: string; expires_at: string; revoked_at: string;
}
interface ServiceCapabilityRule { id: string; name: string; version: number; input?: Record<string, unknown> }
interface ServiceAccount {
  id: string; owner_user_id: string; grant_id: string; name: string; capabilities_json: string;
  max_invocations: number; invocation_count: number; created_at: string; expires_at: string; revoked_at: string;
}
const automationDefinition = (d: CapabilityDefinition) => d.effect === "read" && d.operationKind === "center_read"
  && ["R0", "R1"].includes(d.risk) && d.exposure.mcp && d.exposure.http && d.roles.includes("admin");
const fixedJSON = (value: unknown, depth = 0): any => {
  if (depth > 8) fail(400, "服务输入约束最多嵌套 8 层");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(value)) return value;
  if (Array.isArray(value) && value.length <= 100) return value.map(item => fixedJSON(item, depth + 1));
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length <= 100) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fixedJSON(item, depth + 1)]));
  }
  fail(400, "无效的服务输入约束");
};
export const serviceInputMatches = (input: unknown, constraint: unknown): boolean => {
  if (constraint && typeof constraint === "object" && !Array.isArray(constraint)) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return false;
    return Object.entries(constraint).every(([key, value]) => Object.hasOwn(input, key) && serviceInputMatches((input as any)[key], value));
  }
  if (Array.isArray(constraint)) return Array.isArray(input) && input.length === constraint.length && constraint.every((value, index) => serviceInputMatches(input[index], value));
  return input === constraint;
};
export const accessObject = (value: unknown, fields: string[]) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) fail(400, "无效的 MCP 授权参数");
  return value as Record<string, any>;
};
const name = (v: unknown): string => {
  if (typeof v !== "string" || !v.trim() || v.length > 100 || /[\p{Cc}]/u.test(v)) fail(400, "名称长度为 1 到 100 个字符");
  return v.trim();
};
/** Dedicated resource-server credentials. No ingestion, Agent or browser credential is accepted here. */
export class McpAccess extends SessionAccess implements AccessAuthority {
  readonly endpoint: string;
  readonly origin: string;
  private cleanupAfter = 0;
  constructor(deps: Dependencies) {
    super(deps);
    let base: URL;
    try { base = new URL(deps.externalURL); } catch { throw Error("MCP requires a configured externalURL"); }
    if (!isMcpExternalURL(deps.externalURL)) throw Error("MCP externalURL must be an HTTPS origin or local HTTP origin");
    this.origin = base.origin; this.endpoint = base.origin + "/api/v1/mcp";
    deps.db.exec(`CREATE TABLE IF NOT EXISTS mcp_access_grants(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT NOT NULL,client_id TEXT NOT NULL DEFAULT '',name TEXT NOT NULL,resource TEXT NOT NULL,scopes_json TEXT NOT NULL,host_ids_json TEXT NOT NULL,issued_role TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS mcp_grants_user ON mcp_access_grants(user_id);
CREATE TABLE IF NOT EXISTS mcp_access_tokens(id TEXT PRIMARY KEY,grant_id TEXT NOT NULL REFERENCES mcp_access_grants(id),token_hash TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,used_at TEXT NOT NULL DEFAULT '',revoked_at TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS mcp_tokens_grant ON mcp_access_tokens(grant_id);
CREATE TABLE IF NOT EXISTS mcp_oauth_clients(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,redirect_uris_json TEXT NOT NULL,created_at TEXT NOT NULL,revoked_at TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS mcp_oauth_codes(code_hash TEXT PRIMARY KEY,grant_id TEXT NOT NULL REFERENCES mcp_access_grants(id),client_id TEXT NOT NULL,redirect_uri TEXT NOT NULL,challenge TEXT NOT NULL,resource TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,used_at TEXT NOT NULL DEFAULT '');`);
    deps.db.exec(`CREATE TABLE IF NOT EXISTS mcp_service_accounts(
      id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,grant_id TEXT NOT NULL UNIQUE REFERENCES mcp_access_grants(id),
      name TEXT NOT NULL,capabilities_json TEXT NOT NULL,max_invocations INTEGER NOT NULL,invocation_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS mcp_service_accounts_owner ON mcp_service_accounts(owner_user_id);`);
  }
  now() { return this.deps.now().toISOString(); }
  cleanup() {
    const now = this.deps.now().getTime();
    if (now < this.cleanupAfter) return;
    this.deps.db.run("DELETE FROM mcp_oauth_codes WHERE expires_at<?", new Date(now - 86400_000).toISOString());
    this.deps.db.run("DELETE FROM mcp_access_tokens WHERE expires_at<?", new Date(now - 30 * 86400_000).toISOString());
    this.cleanupAfter = now + 3600_000;
  }
  selection(user: User, scope: unknown, hosts: unknown): {scopes: string[]; host_ids: string[] | null} {
    const fresh = this.currentUser(user.id), allowed = scopesForUser(fresh);
    if (!Array.isArray(scope) || !scope.length || scope.length > CAPABILITY_SCOPES.length || scope.some(s => typeof s !== "string" || !allowed.includes(s)) || new Set(scope).size !== scope.length) fail(403, "所选能力未获授权");
    if (hosts !== null && (!Array.isArray(hosts) || hosts.length > 200 || hosts.some(h => typeof h !== "string" || !h || h.length > 128) || new Set(hosts).size !== hosts.length)) fail(400, "请选择全部主机或明确的主机 ID");
    if (hosts !== null) {
      for (const hostID of hosts as string[]) if (!this.deps.db.get("SELECT id FROM managed_machines WHERE id=?", hostID)) fail(400, "所选主机不可用");
    }
    return { scopes: [...scope].sort(), host_ids: hosts === null ? null : [...hosts].sort() };
  }
  lifetime(value: unknown = 168): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 8760) fail(400, "授权期限须为 1 到 8760 小时");
    return value;
  }
  grant(user: User, kind: "pat" | "oauth", label: string, scopes: string[], host_ids: string[] | null, hours: number, clientID = ""): AccessGrant {
    const fresh = this.currentUser(user.id), now = this.now();
    const grant: AccessGrant = { id: randomUUID(), user_id: fresh.id, kind, client_id: clientID, name: label,
      resource: this.endpoint, scopes_json: JSON.stringify(scopes), host_ids_json: JSON.stringify(host_ids), issued_role: fresh.role,
      created_at: now, expires_at: new Date(this.deps.now().getTime() + hours * 3600_000).toISOString(), revoked_at: "" };
    this.deps.db.run("INSERT INTO mcp_access_grants(id,user_id,kind,client_id,name,resource,scopes_json,host_ids_json,issued_role,created_at,expires_at,revoked_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      grant.id, grant.user_id, grant.kind, grant.client_id, grant.name, grant.resource, grant.scopes_json, grant.host_ids_json, grant.issued_role, now, grant.expires_at, "");
    return grant;
  }
  issue(grant: AccessGrant, kind: "pat" | "access" | "refresh" | "service", lifetimeMs?: number) {
    const raw = ({ pat: "lm_pat_", access: "lm_oat_", refresh: "lm_ort_", service: "lm_sat_" }[kind]) + token(), id = randomUUID();
    const expires = lifetimeMs ? new Date(Math.min(Date.parse(grant.expires_at), this.deps.now().getTime() + lifetimeMs)).toISOString() : grant.expires_at;
    this.deps.db.run("INSERT INTO mcp_access_tokens(id,grant_id,token_hash,kind,created_at,expires_at) VALUES(?,?,?,?,?,?)", id, grant.id, hash(raw), kind, this.now(), expires);
    return { id, token: raw, expires_at: expires };
  }
  createToken(user: User, input: unknown) {
    this.cleanup();
    const v = accessObject(input, ["name", "scopes", "host_ids", "expires_in_hours"]);
    const selected = this.selection(user, v.scopes, v.host_ids), hours = this.lifetime(v.expires_in_hours ?? 168), label = name(v.name);
    return this.deps.db.transaction(() => {
      if (this.deps.db.get<{n:number}>("SELECT count(*) n FROM mcp_access_grants WHERE user_id=? AND kind='pat' AND revoked_at='' AND expires_at>?", user.id, this.now())!.n >= 100) fail(409, "最多保留 100 个有效个人令牌");
      const grant = this.grant(user, "pat", label, selected.scopes, selected.host_ids, hours), issued = this.issue(grant, "pat");
      return { ...issued, name: label, scopes: selected.scopes, host_ids: selected.host_ids, created_at: grant.created_at, grant_id: grant.id };
    });
  }
  private admin(user: User): User {
    const fresh = this.currentUser(user.id);
    if (fresh.role !== "admin") fail(403, "需要管理员权限");
    return fresh;
  }
  createServiceAccount(user: User, input: unknown, definitions: readonly CapabilityDefinition[]) {
    this.cleanup();
    const owner = this.admin(user);
    const v = accessObject(input, ["name", "capabilities", "host_ids", "expires_in_hours", "max_invocations"]);
    if (!Array.isArray(v.capabilities) || !v.capabilities.length || v.capabilities.length > 20) fail(400, "请选择 1 到 20 个固定能力");
    if (!Number.isInteger(v.max_invocations) || v.max_invocations < 1 || v.max_invocations > 100000) fail(400, "调用预算须为 1 到 100000 的整数");
    const names = new Set<string>(), scopes = new Set<string>();
    const rules: ServiceCapabilityRule[] = v.capabilities.map((raw: unknown) => {
      const rule = accessObject(raw, ["name", "version", "input"]);
      const d = definitions.find(candidate => candidate.name === rule.name);
      if (!d || !automationDefinition(d) || rule.version !== d.version || names.has(d.name)) fail(403, "automation_capability_forbidden");
      if (rule.input !== undefined && (!rule.input || typeof rule.input !== "object" || Array.isArray(rule.input))) fail(400, "服务输入约束必须是对象");
      const constraint = fixedJSON(rule.input ?? {});
      if (Buffer.byteLength(JSON.stringify(constraint)) > 4096) fail(400, "服务输入约束过大");
      names.add(d.name); scopes.add(d.scope); for (const scope of d.additionalScopes ?? []) scopes.add(scope);
      return { id: d.id, name: d.name, version: d.version, input: constraint };
    });
    if (v.host_ids !== null && definitions.some(d => names.has(d.name) && d.allHosts)) fail(403, "explicit_hosts_required");
    const selected = this.selection(owner, [...scopes].sort(), v.host_ids), hours = this.lifetime(v.expires_in_hours ?? 168), label = name(v.name);
    const serviceID = "svc_" + randomUUID(), grantID = randomUUID(), created = this.now();
    const expires = new Date(this.deps.now().getTime() + hours * 3600_000).toISOString();
    return this.deps.db.transaction(() => {
      if (this.deps.db.get<{n:number}>("SELECT count(*) n FROM mcp_service_accounts WHERE owner_user_id=? AND revoked_at='' AND expires_at>?", owner.id, created)!.n >= 50) fail(409, "最多保留 50 个有效服务主体");
      const grant: AccessGrant = { id: grantID, user_id: serviceID, kind: "service", client_id: "", name: label,
        resource: this.endpoint, scopes_json: JSON.stringify(selected.scopes), host_ids_json: JSON.stringify(selected.host_ids), issued_role: "admin",
        created_at: created, expires_at: expires, revoked_at: "" };
      this.deps.db.run("INSERT INTO mcp_access_grants(id,user_id,kind,client_id,name,resource,scopes_json,host_ids_json,issued_role,created_at,expires_at,revoked_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'')",
        grant.id, grant.user_id, grant.kind, "", grant.name, grant.resource, grant.scopes_json, grant.host_ids_json, grant.issued_role, created, expires);
      this.deps.db.run("INSERT INTO mcp_service_accounts(id,owner_user_id,grant_id,name,capabilities_json,max_invocations,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
        serviceID, owner.id, grantID, label, JSON.stringify(rules), v.max_invocations, created, expires);
      const issued = this.issue(grant, "service");
      return { ...issued, service_id: serviceID, name: label, capabilities: rules, scopes: selected.scopes, host_ids: selected.host_ids,
        max_invocations: v.max_invocations, invocation_count: 0, created_at: created, grant_id: grantID };
    });
  }
  private servicePolicy(principal: Principal) {
    if (principal.subject_type !== "service" || !principal.grant_id) fail(403, "automation_capability_forbidden");
    const account = this.deps.db.get<ServiceAccount>("SELECT * FROM mcp_service_accounts WHERE grant_id=? AND id=?", principal.grant_id, principal.user.id);
    if (!account || account.revoked_at || account.expires_at <= this.now()) fail(401, "MCP 授权已失效");
    return account;
  }
  allowsCapability(principal: Principal, definition: CapabilityDefinition): boolean {
    if (principal.subject_type !== "service") return true;
    const account = this.servicePolicy(principal), rules = JSON.parse(account.capabilities_json) as ServiceCapabilityRule[];
    return automationDefinition(definition) && rules.some(rule => rule.id === definition.id && rule.name === definition.name && rule.version === definition.version);
  }
  authorizeInvocation(principal: Principal, definition: CapabilityDefinition, input: unknown): void {
    if (principal.subject_type !== "service") return;
    const fresh = this.validateGrant(principal.grant_id, principal.user.id);
    if (fresh.subject_type !== "service") fail(403, "automation_capability_forbidden");
    const account = this.servicePolicy(fresh), rules = JSON.parse(account.capabilities_json) as ServiceCapabilityRule[];
    const rule = rules.find(candidate => candidate.id === definition.id && candidate.name === definition.name && candidate.version === definition.version);
    if (!rule || !automationDefinition(definition)) fail(403, "automation_capability_forbidden");
    if (!serviceInputMatches(input, rule.input ?? {})) fail(403, "automation_input_forbidden");
    const consumed = this.deps.db.run(`UPDATE mcp_service_accounts AS a SET invocation_count=invocation_count+1
      WHERE a.id=? AND a.invocation_count<a.max_invocations AND a.revoked_at='' AND a.expires_at>?
      AND EXISTS(SELECT 1 FROM mcp_access_grants g WHERE g.id=a.grant_id AND g.revoked_at='' AND g.expires_at>? AND g.resource=?)
      AND EXISTS(SELECT 1 FROM users u WHERE u.id=a.owner_user_id AND u.active=1 AND u.role='admin')`, account.id, this.now(), this.now(), this.endpoint);
    if (!consumed.changes) {
      const current = this.deps.db.get<ServiceAccount>("SELECT * FROM mcp_service_accounts WHERE id=?", account.id);
      if (current && current.invocation_count >= current.max_invocations) fail(429, "automation_budget_exhausted");
      fail(403, "automation_capability_forbidden");
    }
  }
  revokeServiceAccount(user: User, serviceID: string): void {
    this.admin(user);
    const account = this.deps.db.get<ServiceAccount>("SELECT * FROM mcp_service_accounts WHERE id=? AND owner_user_id=?", serviceID, user.id);
    if (!account) fail(404, "服务主体不存在");
    this.deps.db.transaction(() => {
      const at = this.now();
      this.deps.db.run("UPDATE mcp_service_accounts SET revoked_at=? WHERE id=? AND revoked_at=''", at, account.id);
      this.deps.db.run("UPDATE mcp_access_grants SET revoked_at=? WHERE id=? AND revoked_at=''", at, account.grant_id);
      this.deps.db.run("UPDATE mcp_access_tokens SET revoked_at=? WHERE grant_id=? AND revoked_at=''", at, account.grant_id);
    });
  }
  validateGrant(grantID: string, userID?: string): Principal {
    const grant = this.deps.db.get<AccessGrant>("SELECT * FROM mcp_access_grants WHERE id=?", grantID);
    if (!grant || (userID !== undefined && grant.user_id !== userID) || grant.revoked_at || grant.expires_at <= this.now() || grant.resource !== this.endpoint) fail(401, "MCP 授权已失效");
    if (grant.kind === "service") {
      const account = this.deps.db.get<ServiceAccount>("SELECT * FROM mcp_service_accounts WHERE id=? AND grant_id=?", grant.user_id, grant.id);
      if (!account || account.revoked_at || account.expires_at !== grant.expires_at) fail(401, "MCP 授权已失效");
      const owner = this.currentUser(account.owner_user_id);
      if (owner.role !== "admin") fail(401, "账户权限已变化，请重新授权");
      return { user: { id: account.id, name: account.name, role: "admin" }, scopes: JSON.parse(grant.scopes_json), host_ids: JSON.parse(grant.host_ids_json),
        credential_id: "", grant_id: grant.id, source: "mcp", subject_type: "service", owner_user_id: owner.id };
    }
    const user = this.currentUser(grant.user_id);
    if (user.role !== grant.issued_role) fail(401, "账户权限已变化，请重新授权");
    if (grant.client_id && !this.deps.db.get("SELECT id FROM mcp_oauth_clients WHERE id=? AND revoked_at=''", grant.client_id)) fail(401, "MCP 客户端已撤销");
    const permitted = scopesForUser(user);
    return { user, scopes: (JSON.parse(grant.scopes_json) as string[]).filter(scope => permitted.includes(scope)), host_ids: JSON.parse(grant.host_ids_json), credential_id: "", grant_id: grant.id, source: "mcp" };
  }
  authenticate(req: IncomingMessage): Principal {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !/^Bearer (?:lm_pat_|lm_oat_|lm_sat_)[A-Za-z0-9_-]{43}$/i.test(header)) fail(401, "请提供有效的 MCP Bearer 凭据");
    const raw = header.slice(7), row = this.deps.db.get<{id:string;grant_id:string;kind:string;expires_at:string;revoked_at:string}>("SELECT id,grant_id,kind,expires_at,revoked_at FROM mcp_access_tokens WHERE token_hash=?", hash(raw));
    if (!row || !["pat", "access", "service"].includes(row.kind) || row.revoked_at || row.expires_at <= this.now()) fail(401, "MCP 凭据已失效");
    const principal = this.validateGrant(row.grant_id); principal.credential_id = row.id;
    this.deps.db.run("UPDATE mcp_access_tokens SET used_at=? WHERE id=?", this.now(), row.id);
    return principal;
  }
  validate(principal: Principal): void {
    if (principal.source !== "mcp") {
      if (principal.credential_id || principal.grant_id) fail(401, "无效的能力主体");
      const fresh = this.sessionPrincipal(principal.user, principal.source); Object.assign(principal, fresh); return;
    }
    const row = this.deps.db.get<{grant_id:string;expires_at:string;revoked_at:string;kind:string}>("SELECT grant_id,expires_at,revoked_at,kind FROM mcp_access_tokens WHERE id=?", principal.credential_id);
    if (!row || row.grant_id !== principal.grant_id || !["pat", "access", "service"].includes(row.kind) || row.revoked_at || row.expires_at <= this.now()) fail(401, "MCP 凭据已失效");
    const fresh = this.validateGrant(row.grant_id, principal.user.id); fresh.credential_id = principal.credential_id; Object.assign(principal, fresh);
  }
  revokeGrant(user: User, grantID: string): void {
    const grant = this.deps.db.get<AccessGrant>("SELECT * FROM mcp_access_grants WHERE id=? AND user_id=?", grantID, user.id);
    if (!grant) fail(404, "授权不存在");
    this.deps.db.run("UPDATE mcp_access_grants SET revoked_at=? WHERE id=? AND revoked_at=''", this.now(), grantID);
  }
  revokeToken(user: User, tokenID: string): void {
    const row = this.deps.db.get<{grant_id:string}>("SELECT t.grant_id FROM mcp_access_tokens t JOIN mcp_access_grants g ON g.id=t.grant_id WHERE t.id=? AND t.kind='pat' AND g.user_id=?", tokenID, user.id);
    if (!row) fail(404, "令牌不存在");
    this.revokeGrant(user, row.grant_id);
  }
  summary(user: User) {
    this.currentUser(user.id);
    const grants = this.deps.db.all<AccessGrant>("SELECT * FROM mcp_access_grants WHERE user_id=? ORDER BY CASE WHEN revoked_at='' AND expires_at>? THEN 0 ELSE 1 END,created_at DESC,id LIMIT 200", user.id, this.now()).map(({ scopes_json, host_ids_json, issued_role: _role, resource: _resource, ...g }) => ({ ...g, scopes: JSON.parse(scopes_json), host_ids: JSON.parse(host_ids_json), active: !g.revoked_at && g.expires_at > this.now() }));
    const tokens = this.deps.db.all<any>("SELECT t.id,t.grant_id,g.name,g.scopes_json,g.host_ids_json,t.created_at,t.expires_at,t.used_at,g.revoked_at FROM mcp_access_tokens t JOIN mcp_access_grants g ON g.id=t.grant_id WHERE g.user_id=? AND t.kind='pat' ORDER BY CASE WHEN g.revoked_at='' AND t.expires_at>? THEN 0 ELSE 1 END,t.created_at DESC,t.id LIMIT 200", user.id, this.now())
      .map(({scopes_json,host_ids_json,...t}) => ({...t,scopes:JSON.parse(scopes_json),host_ids:JSON.parse(host_ids_json),active:!t.revoked_at&&t.expires_at>this.now()}));
    const clients = this.deps.db.all<any>("SELECT id,name,redirect_uris_json,created_at,revoked_at FROM mcp_oauth_clients WHERE user_id=? ORDER BY CASE WHEN revoked_at='' THEN 0 ELSE 1 END,created_at DESC,id LIMIT 100", user.id)
      .map(({redirect_uris_json,...c}) => ({...c,redirect_uris:JSON.parse(redirect_uris_json)}));
    const serviceAccounts = this.deps.db.all<any>(`SELECT a.*,g.scopes_json,g.host_ids_json,g.revoked_at grant_revoked_at,t.id credential_id,t.used_at,t.revoked_at token_revoked_at
      FROM mcp_service_accounts a JOIN mcp_access_grants g ON g.id=a.grant_id
      LEFT JOIN mcp_access_tokens t ON t.grant_id=a.grant_id AND t.kind='service'
      WHERE a.owner_user_id=? ORDER BY CASE WHEN a.revoked_at='' AND a.expires_at>? THEN 0 ELSE 1 END,a.created_at DESC,a.id LIMIT 100`, user.id, this.now())
      .map(({capabilities_json,scopes_json,host_ids_json,grant_revoked_at,token_revoked_at,...account}) => ({...account,capabilities:JSON.parse(capabilities_json),scopes:JSON.parse(scopes_json),host_ids:JSON.parse(host_ids_json),
        active:!account.revoked_at&&!grant_revoked_at&&!token_revoked_at&&account.expires_at>this.now()}));
    return { endpoint: this.endpoint, scopes: scopesForUser(this.currentUser(user.id)), tokens, grants: grants.filter(g => g.kind === "oauth"), clients, service_accounts: serviceAccounts };
  }
}

export function registerMcpAccess(deps: Dependencies, access: McpAccess): void {
  const r = deps.router, base = "/api/v1/mcp-access";
  r.get(base, c => { c.res.setHeader("cache-control", "no-store"); c.json(access.summary(c.user)); });
  r.post(base + "/tokens", async c => {
    c.res.setHeader("cache-control", "no-store");
    let input: unknown;
    try { input = JSON.parse((await c.raw(16 << 10)).toString()); } catch (error) { if (error instanceof HTTPError) throw error; fail(400, "无效的 JSON 请求"); }
    c.json(access.createToken(c.user, input), 201);
  });
  r.delete(base + "/tokens/:id", c => { access.revokeToken(c.user, c.params.id); c.json({ok:true}); });
  r.delete(base + "/grants/:id", c => { access.revokeGrant(c.user, c.params.id); c.json({ok:true}); });
  registerMcpOAuth(deps, access);
}

export function registerMcpServiceAccounts(deps: Dependencies, access: McpAccess, definitions: readonly CapabilityDefinition[]): void {
  const base = "/api/v1/mcp-access/service-accounts";
  deps.router.post(base, async c => {
    c.res.setHeader("cache-control", "no-store");
    let input: unknown;
    try { input = JSON.parse((await c.raw(16 << 10)).toString()); } catch (error) { if (error instanceof HTTPError) throw error; fail(400, "无效的 JSON 请求"); }
    c.json(access.createServiceAccount(c.user, input, definitions), 201);
  });
  deps.router.delete(base + "/:id", c => { access.revokeServiceAccount(c.user, c.params.id); c.json({ok:true}); });
}
