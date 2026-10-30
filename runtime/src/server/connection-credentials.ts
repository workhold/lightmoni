import { createHash } from "node:crypto";
import ssh2 from "ssh2";
import { id } from "../shared/crypto.js";
import { fail } from "../shared/http.js";
import type { Dependencies, Handler } from "../shared/types.js";
import { machineCredentialCurrent } from "./machine-credential-policy.js";

type Row = Record<string, any>;
const text = (value: unknown, field: string, maximum: number) => {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maximum || /[\u0000-\u001f\u007f]/.test(value)) fail(400, `invalid ${field}`);
  return value.trim();
};
const fields = (input: unknown, allowed: string[]): Row => {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) fail(400, "invalid credential request");
  return input as Row;
};
export function privateKeyFingerprint(secret: string): string {
  const parsed = ssh2.utils.parseKey(secret);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (key instanceof Error || !key || !key.isPrivateKey()) fail(400, "请提供可直接用于 SSH 的完整私钥；加密私钥需先解密");
  return "SHA256:" + createHash("sha256").update(key.getPublicSSH()).digest("base64").replace(/=+$/, "");
}

/** The vault owns encrypted material; machine_credentials retain stable binding IDs. */
export function connectionCredentials(deps: Dependencies, invalidated: (bindingID: string, reason: "expired" | "revoked", actorID?: string) => void) {
  const { db } = deps, at = () => deps.now().toISOString();
  db.exec(`CREATE TABLE IF NOT EXISTS connection_credentials(
    id TEXT PRIMARY KEY,name TEXT NOT NULL,method TEXT NOT NULL,
    secret_encrypted TEXT NOT NULL,secret_fingerprint TEXT NOT NULL DEFAULT '',
    retention TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL,created_by TEXT NOT NULL,
    revoked_at TEXT,secret_cleared_at TEXT NOT NULL DEFAULT '',clear_reason TEXT NOT NULL DEFAULT '',last_used_at TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS connection_credentials_fingerprint ON connection_credentials(method,secret_fingerprint);
  CREATE TABLE IF NOT EXISTS connection_credential_events(
    id TEXT PRIMARY KEY,credential_id TEXT NOT NULL,event TEXT NOT NULL,actor_id TEXT NOT NULL,created_at TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS connection_credential_migrations(id TEXT PRIMARY KEY,finished_at TEXT NOT NULL);`);
  const columns = new Set(db.all<{ name: string }>("PRAGMA table_info(machine_credentials)").map(row => row.name));
  if (!columns.has("connection_credential_id")) db.exec("ALTER TABLE machine_credentials ADD COLUMN connection_credential_id TEXT NOT NULL DEFAULT ''");
  if (!columns.has("quarantined_at")) db.exec("ALTER TABLE machine_credentials ADD COLUMN quarantined_at TEXT NOT NULL DEFAULT ''");
  const hostColumns = new Set(db.all<{ name: string }>("PRAGMA table_info(managed_machines)").map(row => row.name));
  if (!hostColumns.has("default_credential_id")) db.exec("ALTER TABLE managed_machines ADD COLUMN default_credential_id TEXT NOT NULL DEFAULT ''");
  db.exec(`CREATE INDEX IF NOT EXISTS machine_credentials_connection ON machine_credentials(connection_credential_id);
    DROP VIEW IF EXISTS effective_machine_credentials;
    CREATE VIEW effective_machine_credentials AS SELECT
      b.id,b.machine_id,b.method,b.connection_credential_id,COALESCE(g.name,'') AS name,
      CASE WHEN b.revoked_at IS NOT NULL OR b.secret_cleared_at!='' OR b.quarantined_at!='' THEN '' WHEN b.connection_credential_id='' THEN b.secret_encrypted ELSE COALESCE(g.secret_encrypted,'') END AS secret_encrypted,
      CASE WHEN b.connection_credential_id='' THEN b.secret_fingerprint ELSE COALESCE(g.secret_fingerprint,'') END AS secret_fingerprint,
      CASE WHEN b.retention='permanent' AND b.expires_at!='' THEN b.retention WHEN g.id IS NOT NULL AND b.retention='permanent' AND g.retention!='permanent' THEN g.retention ELSE b.retention END AS retention,
      CASE WHEN g.id IS NULL OR g.retention='permanent' THEN b.expires_at
           WHEN b.retention='permanent' OR julianday(g.expires_at)<=julianday(b.expires_at) THEN g.expires_at ELSE b.expires_at END AS expires_at,
      b.policy_source,COALESCE(b.revoked_at,g.revoked_at) AS revoked_at,
      CASE WHEN b.quarantined_at!='' THEN b.quarantined_at WHEN b.secret_cleared_at!='' THEN b.secret_cleared_at ELSE COALESCE(g.secret_cleared_at,'') END AS secret_cleared_at,
      CASE WHEN b.quarantined_at!='' THEN 'invalid' WHEN b.clear_reason!='' THEN b.clear_reason ELSE COALESCE(g.clear_reason,'') END AS clear_reason,
      b.created_at,b.created_by,b.last_used_at
    FROM machine_credentials b LEFT JOIN connection_credentials g ON g.id=b.connection_credential_id;`);
  const row = (credentialID: string) => {
    const value = db.get<Row>("SELECT * FROM connection_credentials WHERE id=?", credentialID);
    if (!value) fail(404, "连接凭据不存在");
    return value;
  };
  const current = (value: Row) => !value.revoked_at && !value.secret_cleared_at && !!value.secret_encrypted && machineCredentialCurrent(value as any, deps.now());
  const hosts = (credentialID: string) => db.all<{ id: string; name: string }>(`SELECT DISTINCT m.id,m.name FROM machine_credentials b JOIN managed_machines m ON m.id=b.machine_id
    WHERE b.connection_credential_id=? AND b.revoked_at IS NULL AND b.secret_cleared_at='' ORDER BY m.name,m.id`, credentialID);
  const publicRow = (value: Row) => ({
    id: value.id, name: value.name, method: value.method, secret_fingerprint: value.secret_fingerprint,
    retention: value.retention, expires_at: value.expires_at, created_at: value.created_at, created_by: value.created_by,
    revoked_at: value.revoked_at, secret_cleared_at: value.secret_cleared_at, clear_reason: value.clear_reason,
    last_used_at: value.last_used_at, hosts: hosts(value.id),
    status: value.revoked_at ? "revoked" : current(value) ? "active" : "expired",
  });
  const insert = (input: {name: string;method: string;secret: string;fingerprint: string;retention: string;expiresAt: string;actorID: string;createdAt?: string}) => {
    const credentialID = id(), created = input.createdAt || at();
    const encrypted = deps.encrypt(JSON.stringify({ connection_credential_id: credentialID, secret: input.secret }));
    db.run(`INSERT INTO connection_credentials(id,name,method,secret_encrypted,secret_fingerprint,retention,expires_at,created_at,created_by)
      VALUES(?,?,?,?,?,?,?,?,?)`, credentialID, input.name, input.method, encrypted, input.fingerprint, input.retention, input.expiresAt, created, input.actorID);
    db.run("INSERT INTO connection_credential_events(id,credential_id,event,actor_id,created_at) VALUES(?,?,?,?,?)", id(), credentialID, "created", input.actorID, created);
    return row(credentialID);
  };
  const validate = (input: Row) => {
    const name = text(input.name, "name", 128), method = input.method;
    if (method !== "password" && method !== "ssh_key") fail(400, "invalid credential method");
    if (typeof input.secret !== "string" || !input.secret.length || Buffer.byteLength(input.secret) > (method === "password" ? 4096 : 64 << 10)) fail(400, "invalid secret");
    const secret = method === "password" ? input.secret : input.secret.trim();
    const fingerprint = method === "ssh_key" ? privateKeyFingerprint(secret) : "";
    if (input.retention!==undefined && typeof input.retention!=="string") fail(400,"invalid retention");
    const retention = input.retention ?? "managed";
    if (!["managed", "permanent", "temporary", "one_time"].includes(retention) || method === "ssh_key" && retention === "one_time") fail(400, "invalid retention");
    if (input.confirm_managed !== undefined && typeof input.confirm_managed !== "boolean" || input.confirm_permanent !== undefined && typeof input.confirm_permanent !== "boolean") fail(400, "invalid retention confirmation");
    if (retention === "managed" && input.confirm_managed !== true) fail(400, "托管保存需要明确确认 confirm_managed=true");
    if (retention === "permanent" && input.confirm_permanent !== true) fail(400, "永久保存需要明确确认 confirm_permanent=true");
    if (retention !== "managed" && input.confirm_managed === true || retention !== "permanent" && input.confirm_permanent === true) fail(400, "invalid retention confirmation");
    if (retention === "permanent" && Object.hasOwn(input,"expires_in_seconds")) fail(400, "永久保存不能同时指定 expires_in_seconds");
    const maximum = retention === "managed" ? 365 * 86400 : 3600;
    const seconds = input.expires_in_seconds ?? (retention === "managed" ? 21600 : method === "password" ? 900 : 3600);
    if (retention !== "permanent" && (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > maximum)) fail(400, "invalid expires_in_seconds");
    return {name,method,secret,fingerprint,retention,expiresAt: retention === "permanent" ? "" : new Date(deps.now().getTime()+seconds*1000).toISOString()};
  };
  const create = (input: Row, actorID: string) => {
    const value = validate(input);
    if (value.fingerprint) {
      const duplicate = db.all<Row>("SELECT * FROM connection_credentials WHERE method='ssh_key' AND secret_fingerprint=? ORDER BY created_at,id", value.fingerprint).find(current);
      if (duplicate) return {...publicRow(duplicate), reused:true};
    }
    const added = insert({...value,actorID});
    return {...publicRow(added), reused:false};
  };
  const ensure = (credentialID: string) => {
    const value = row(credentialID);
    if (!current(value)) fail(409, "连接凭据已过期、撤销或清除，请更新凭据");
    return value;
  };
  const clear = (credentialID: string, reason: "revoked" | "expired", actorID = "system") => {
    const value = row(credentialID), affected = hosts(credentialID), timestamp = at();
    db.transaction(() => {
      db.run(`UPDATE connection_credentials SET secret_encrypted='',secret_cleared_at=CASE WHEN secret_cleared_at='' THEN ? ELSE secret_cleared_at END,
        clear_reason=CASE WHEN clear_reason='' THEN ? ELSE clear_reason END,revoked_at=CASE WHEN ?='revoked' THEN COALESCE(revoked_at,?) ELSE revoked_at END WHERE id=?`, timestamp, reason, reason, timestamp, credentialID);
      if (!value.secret_cleared_at) db.run("INSERT INTO connection_credential_events(id,credential_id,event,actor_id,created_at) VALUES(?,?,?,?,?)", id(), credentialID, reason, actorID, timestamp);
    });
    for (const binding of db.all<{id:string}>("SELECT id FROM machine_credentials WHERE connection_credential_id=?",credentialID)) invalidated(binding.id,reason,actorID);
    return {...publicRow(row(credentialID)), affected_hosts:affected};
  };
  const cleanup = () => {
    for (const value of db.all<Row>("SELECT * FROM connection_credentials WHERE secret_encrypted!='' OR secret_cleared_at=''")) if (!current(value)) clear(value.id,value.revoked_at?"revoked":"expired");
  };
  const lifetime = (input: Row) => { const value=validate(input); return {retention:value.retention,expiresAt:value.expiresAt}; };
  const bind = (machineID: string, credentialID: string, actorID: string, makeDefault = true, requested?: {retention:string;expiresAt:string}) => {
    const value = ensure(credentialID), existing = db.get<Row>(`SELECT * FROM effective_machine_credentials WHERE machine_id=? AND connection_credential_id=?
      AND revoked_at IS NULL AND secret_cleared_at='' ORDER BY created_at DESC,id DESC`,machineID,credentialID);
    if (value.retention === "one_time" && db.get("SELECT id FROM machine_credentials WHERE connection_credential_id=? AND (machine_id!=? OR revoked_at IS NOT NULL OR secret_cleared_at!='') LIMIT 1",credentialID,machineID)) fail(409,"一次性密码只允许绑定一台主机并使用一次，请添加新凭据");
    let bindingID = existing && machineCredentialCurrent(existing as any,deps.now()) ? existing.id : "";
    const policy={retention:requested?.retention ?? value.retention,expiresAt:requested?.expiresAt ?? value.expires_at};
    if (value.retention!=="permanent" && (policy.retention==="permanent" || Date.parse(policy.expiresAt)>Date.parse(value.expires_at))) {
      if (policy.retention==="permanent") policy.retention=value.retention;
      policy.expiresAt=value.expires_at;
    }
    if (!bindingID) {
      bindingID = id();
      db.run(`INSERT INTO machine_credentials(id,machine_id,connection_credential_id,method,secret_encrypted,secret_fingerprint,retention,policy_source,created_at,expires_at,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`,bindingID,machineID,value.id,value.method,"",value.secret_fingerprint,policy.retention,"explicit",at(),policy.expiresAt,actorID);
      db.run("INSERT INTO machine_credential_events(id,machine_id,credential_id,event,actor_id,created_at) VALUES(?,?,?,?,?,?)",id(),machineID,bindingID,"bound",actorID,at());
    } else if (requested && policy.retention!=="permanent" && (existing!.retention==="permanent" || Date.parse(policy.expiresAt)<Date.parse(existing!.expires_at))) {
      // Re-entering the same key must honor a shorter requested lifetime,
      // without silently renewing an existing binding's deadline.
      db.run("UPDATE machine_credentials SET retention=?,expires_at=? WHERE id=?",policy.retention,policy.expiresAt,bindingID);
    }
    if (makeDefault) db.run("UPDATE managed_machines SET default_credential_id=? WHERE id=?",bindingID,machineID);
    return bindingID;
  };
  // Older IDs and per-host deadlines stay intact. Only valid, decryptable
  // reusable material is moved; malformed history remains isolated.
  const migrate = () => {
    if (db.get("SELECT id FROM connection_credential_migrations WHERE id='vault-v1'")) return;
    db.transaction(() => {
      for (const binding of db.all<Row>("SELECT b.*,m.name AS machine_name FROM machine_credentials b JOIN managed_machines m ON m.id=b.machine_id WHERE connection_credential_id='' AND revoked_at IS NULL AND secret_cleared_at='' AND secret_encrypted!='' ORDER BY b.created_at,b.id")) {
        if (!machineCredentialCurrent(binding as any,deps.now())) continue;
        let secret: string, fingerprint = "";
        try {
          const envelope = JSON.parse(deps.decrypt(binding.secret_encrypted));
          if (envelope.machine_id !== binding.machine_id || envelope.credential_id !== binding.id || typeof envelope.secret !== "string" || !envelope.secret) throw Error("invalid legacy envelope");
          secret = envelope.secret;
          if (binding.method === "ssh_key") fingerprint = privateKeyFingerprint(secret);
          else if (binding.method !== "password") throw Error("unsupported legacy method");
        } catch {
          // An incorrect master key must not destroy recoverable old envelopes.
          // Quarantine excludes the row from all SSH/default selectors while
          // retaining only encrypted material and its original history ID.
          db.run("UPDATE machine_credentials SET quarantined_at=? WHERE id=?",at(),binding.id);
          db.run("INSERT INTO machine_credential_events(id,machine_id,credential_id,event,actor_id,created_at) VALUES(?,?,?,?,?,?)",id(),binding.machine_id,binding.id,"invalid","system",at());
          continue;
        }
        let source = fingerprint ? db.get<Row>("SELECT * FROM connection_credentials WHERE method='ssh_key' AND secret_fingerprint=? AND revoked_at IS NULL AND secret_cleared_at='' ORDER BY created_at,id LIMIT 1",fingerprint) : undefined;
        if (!source) source = insert({name:binding.machine_name+" · SSH",method:binding.method,secret,fingerprint,retention:binding.retention,expiresAt:binding.expires_at,actorID:binding.created_by,createdAt:binding.created_at});
        else if (binding.retention === "permanent" || source.retention !== "permanent" && Date.parse(binding.expires_at) > Date.parse(source.expires_at)) {
          // A source must live at least as long as its longest existing binding;
          // each shorter binding remains independently capped by the view.
          db.run("UPDATE connection_credentials SET retention=?,expires_at=? WHERE id=?",binding.retention,binding.expires_at,source.id);
        }
        db.run("UPDATE machine_credentials SET connection_credential_id=?,secret_encrypted='',secret_fingerprint=? WHERE id=?",source.id,fingerprint,binding.id);
      }
      // A deterministic choice is made once during upgrade. Later invalidation
      // never chooses a different credential behind the user's back.
      for (const machine of db.all<Row>("SELECT id FROM managed_machines WHERE default_credential_id=''")) {
        const binding = db.all<Row>("SELECT * FROM effective_machine_credentials WHERE machine_id=? AND revoked_at IS NULL AND secret_cleared_at='' AND secret_encrypted!='' ORDER BY created_at DESC,id DESC",machine.id).find(value=>machineCredentialCurrent(value as any,deps.now()));
        if (binding) db.run("UPDATE managed_machines SET default_credential_id=? WHERE id=?",binding.id,machine.id);
      }
      db.run("INSERT INTO connection_credential_migrations(id,finished_at) VALUES('vault-v1',?)",at());
    });
  };
  const used = (bindingID: string) => {
    const binding = db.get<Row>("SELECT connection_credential_id FROM machine_credentials WHERE id=?",bindingID);
    if (binding?.connection_credential_id) db.run("UPDATE connection_credentials SET last_used_at=? WHERE id=?",at(),binding.connection_credential_id);
  };
  const consumed = (credentialID: string, actorID: string) => {
    const value = row(credentialID);
    if (value.retention !== "one_time" || value.secret_cleared_at) return;
    db.run("UPDATE connection_credentials SET secret_encrypted='',secret_cleared_at=?,clear_reason='consumed' WHERE id=?",at(),credentialID);
    db.run("INSERT INTO connection_credential_events(id,credential_id,event,actor_id,created_at) VALUES(?,?,?,?,?)",id(),credentialID,"consumed",actorID,at());
  };
  const register = (safe: (handler: Handler) => Handler) => {
    const base = "/api/v1/connection-credentials", admin = deps.auth.requireAdmin.bind(deps.auth);
    deps.router.get(base,safe(ctx=>{admin(ctx);cleanup();ctx.json(db.all<Row>("SELECT * FROM connection_credentials ORDER BY created_at DESC,id").map(publicRow));}));
    deps.router.post(base,safe(async ctx=>{admin(ctx);cleanup();const input=fields(await ctx.body(),["name","method","secret","retention","expires_in_seconds","confirm_managed","confirm_permanent"]);ctx.json(create(input,ctx.user.id),201);}));
    deps.router.put(base+"/:id",safe(async ctx=>{admin(ctx);const input=fields(await ctx.body(),["name"]);row(ctx.params.id);db.run("UPDATE connection_credentials SET name=? WHERE id=?",text(input.name,"name",128),ctx.params.id);ctx.json(publicRow(row(ctx.params.id)));}));
    deps.router.post(base+"/:id/revoke",safe(async ctx=>{admin(ctx);const input=fields(await ctx.body(),["confirm"]);if(input.confirm!==true)fail(400,"必须明确确认撤销此凭据及全部关联主机的使用权限");ctx.json(clear(ctx.params.id,"revoked",ctx.user.id));}));
  };
  return {create,ensure,bind,lifetime,cleanup,migrate,used,consumed,register};
}
