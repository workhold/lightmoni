import type { IncomingMessage } from "node:http";
import { hash as passwordHash, compare } from "bcryptjs";
import { DB } from "../shared/sqlite.js";
import { hash, token, id, masterKey, cipher } from "../shared/crypto.js";
import { Router, fail } from "../shared/http.js";
import type {
  Auth as AuthContract,
  Context,
  User,
  WriteKey,
} from "../shared/types.js";
import { registerProfiles } from "./profiles.js";
import { registerOAuth } from "./oauth.js";
import { accountSchema, validPassword } from "./accounts.js";
export { validPassword } from "./accounts.js";

export const validTable = (s: unknown): s is string =>
  typeof s === "string" &&
  /^[a-z][a-z0-9_]{0,47}$/.test(s) &&
  !/^(log_|metric_|trace_)/.test(s);
export const systemTable = (s: string) =>
  /^lightmoni(?:_|$)/.test(s);
const record = (v: any): Record<string, any> => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    fail(400, "invalid request");
  return v;
};
const keyFields = (v: Record<string, any>, allowed: string[]) => {
  if(Object.keys(v).some(key=>!allowed.includes(key)))fail(400,'invalid key field');
  if(v.active!=null&&typeof v.active!=='boolean'||v.name!=null&&typeof v.name!=='string')fail(400,'invalid key');
};
export const cookie = (req: IncomingMessage, name: string) => {
  const part = req.headers.cookie
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(name + "="));
  const value = part?.slice(name.length + 1);
  return value?.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
};
export class Auth implements AuthContract {
  readonly master: Buffer;
  readonly encrypt: (v: string) => string;
  readonly decrypt: (v: string) => string;
  constructor(
    readonly db: DB,
    dir: string,
    readonly externalURL: string,
    readonly router: Router,
  ) {
    accountSchema(db);
    db.exec(`CREATE TABLE IF NOT EXISTS ingest_keys(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,last_used TEXT,upload_batches INTEGER NOT NULL DEFAULT 0,error_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS key_events(id INTEGER PRIMARY KEY AUTOINCREMENT,key_id TEXT NOT NULL,at TEXT NOT NULL,service TEXT NOT NULL DEFAULT '',status TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS sdk_exempt_tables(name TEXT PRIMARY KEY,description TEXT NOT NULL DEFAULT '',active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_providers(id TEXT PRIMARY KEY,config TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS external_identities(provider_id TEXT NOT NULL,subject TEXT NOT NULL,user_id TEXT NOT NULL,PRIMARY KEY(provider_id,subject));
CREATE TABLE IF NOT EXISTS oauth_states(state TEXT PRIMARY KEY,provider_id TEXT NOT NULL,verifier TEXT NOT NULL,created_at INTEGER NOT NULL,user_id TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS user_profiles(user_id TEXT PRIMARY KEY,nickname TEXT NOT NULL DEFAULT '',avatar_url TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS user_notification_profiles(user_id TEXT PRIMARY KEY,body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_return_targets(state TEXT PRIMARY KEY,return_to TEXT NOT NULL);`);
    this.master = masterKey(dir);
    const c = cipher(this.master);
    this.encrypt = c.encrypt;
    this.decrypt = c.decrypt;
  }
  user(req: IncomingMessage): User | undefined {
    const value = cookie(req, "lm_session");
    if (!value) return;
    return this.db.get<User>(
      "SELECT u.id,u.name,u.role,COALESCE(p.nickname,'') nickname,COALESCE(p.avatar_url,'') avatar_url FROM sessions s JOIN users u ON s.user_id=u.id LEFT JOIN user_profiles p ON p.user_id=u.id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1",
      hash(value),
      Math.floor(Date.now() / 1000),
    );
  }
  requireAdmin(ctx: Context) {
    if (ctx.user.role !== "admin") fail(403, "需要管理员权限");
  }
  validateKey(ctx: Context, table?: string, allowExempt = false): WriteKey {
    if (allowExempt && ctx.req.headers.authorization === undefined) {
      const tables = this.db.all<{name:string}>(
        "SELECT name FROM sdk_exempt_tables WHERE active=1 ORDER BY name",
      ).map(row => row.name).filter(name => validTable(name) && !systemTable(name));
      if (!tables.length) fail(401, "请提供 SDK 密钥或使用已启用的豁免表");
      if (table && !tables.includes(table)) fail(403, "无密钥模式只能写入已启用的豁免表");
      return {id:"",name:"无密钥",allowed_tables:tables,allow_all_tables:false};
    }
    const value = ctx.req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const row = this.db.get<any>(
      "SELECT id,name FROM ingest_keys WHERE token_hash=? AND active=1",
      hash(value),
    );
    if (!row) fail(401, "invalid write key");
    const tables: string[] = [];
    if (
      table &&
      !validTable(table)
    )
      fail(403, "key cannot write to this table");
    this.db.run(
      "UPDATE ingest_keys SET last_used=? WHERE id=?",
      new Date().toISOString(),
      row.id,
    );
    return {
      id: row.id,
      name: row.name,
      allowed_tables: tables,
      allow_all_tables: true,
    };
  }
  recordKey(key: string, service: string, status: string, detail = "") {
    if (!key) return;
    this.db.transaction(() => {
      this.db.run(
        "INSERT INTO key_events(key_id,at,service,status,detail) VALUES(?,?,?,?,?)",
        key,
        new Date().toISOString(),
        service,
        status,
        detail.slice(0, 1000),
      );
      const column = status === "accepted" ? "upload_batches" : "error_count";
      this.db.run(
        "UPDATE ingest_keys SET " + column + "=" + column + "+1 WHERE id=?",
        key,
      );
      this.db.run(
        "DELETE FROM key_events WHERE id < (SELECT COALESCE(MAX(id),0)-10000 FROM key_events)",
      );
    });
  }
  session(ctx: Context, userID: string) {
    const value = token();
    this.db.run(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
      hash(value),
      userID,
      Math.floor(Date.now() / 1000) + 604800,
    );
    ctx.res.setHeader(
      "set-cookie",
      "lm_session=" +
        value +
        "; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800" +
        (this.externalURL.startsWith("https:") || "encrypted" in ctx.req.socket
          ? "; Secure"
          : ""),
    );
  }
  register() {
    const r = this.router;
    const db = this.db;
    r.get(
      "/api/v1/setup",
      (c) =>
        c.json({
          required: db.get<any>("SELECT count(*) n FROM users")!.n === 0,
        }),
      { public: true },
    );
    r.post(
      "/api/v1/setup",
      async (c) => {
        r.checkOrigin(c.req);
        const v = record(await c.body());
        if (typeof v.name !== "string" || !v.name || !validPassword(v.password))
          fail(400, "名称和8个字符到72字节密码必填");
        const encrypted = await passwordHash(v.password, 10);
        const user = { id: id(), name: v.name, role: "admin" };
        db.transaction(() => {
          if (db.get<any>("SELECT count(*) n FROM users")!.n !== 0)
            fail(409, "已经初始化");
          db.run(
            "INSERT INTO users(id,name,password_hash,role,active,created_at) VALUES(?,?,?,'admin',1,?)",
            user.id,
            user.name,
            encrypted,
            new Date().toISOString(),
          );
        });
        this.session(c, user.id);
        c.json(user, 201);
      },
      { public: true },
    );
    r.post(
      "/api/v1/auth/login",
      async (c) => {
        r.checkOrigin(c.req);
        const v = record(await c.body());
        if (typeof v.name !== "string" || typeof v.password !== "string")
          fail(400, "invalid login");
        const u = db.get<any>(
          "SELECT u.id,u.name,u.role,u.password_hash,COALESCE(p.nickname,'') nickname,COALESCE(p.avatar_url,'') avatar_url FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id WHERE u.name=? AND u.active=1",
          v.name,
        );
        if (!u || !(await compare(v.password, u.password_hash)))
          fail(401, "用户名或密码错误");
        this.session(c, u.id);
        delete u.password_hash;
        c.json(u);
      },
      { public: true },
    );
    r.post(
      "/api/v1/auth/logout",
      (c) => {
        r.checkOrigin(c.req);
        db.run(
          "DELETE FROM sessions WHERE token_hash=?",
          hash(cookie(c.req, "lm_session") ?? ""),
        );
        c.res.setHeader(
          "set-cookie",
          "lm_session=; Path=/; HttpOnly; Max-Age=0",
        );
        c.json({ ok: true });
      },
      { public: true },
    );
    r.get("/api/v1/auth/me", (c) => c.json(c.user));
    r.get("/api/v1/users", (c) => {
      this.requireAdmin(c);
      c.json(
        db
          .all<any>(
            "SELECT u.id,u.name,u.role,u.active,u.created_at,COALESCE(p.nickname,'') nickname,COALESCE(p.avatar_url,'') avatar_url FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id ORDER BY u.created_at",
          )
          .map((u) => ({ ...u, active: !!u.active })),
      );
    });
    r.post("/api/v1/users", async (c) => {
      this.requireAdmin(c);
      const v = record(await c.body());
      if (
        typeof v.name !== "string" ||
        !v.name ||
        !validPassword(v.password) ||
        !["admin", "member"].includes(v.role) ||
        (v.active != null && typeof v.active !== "boolean")
      )
        fail(400, "用户名、角色及8个字符到72字节密码必填");
      const encrypted = await passwordHash(v.password, 10);
      const uid = id();
      try {
        db.run(
          "INSERT INTO users(id,name,password_hash,role,active,created_at) VALUES(?,?,?,?,?,?)",
          uid,
          v.name,
          encrypted,
          v.role,
          v.active ?? true,
          new Date().toISOString(),
        );
      } catch {
        fail(409, "用户名已存在");
      }
      c.json({ id: uid }, 201);
    });
    r.put("/api/v1/users/:id", async (c) => {
      this.requireAdmin(c);
      const v = record(await c.body());
      if (
        typeof v.name !== "string" ||
        !v.name ||
        !["member", "admin"].includes(v.role) ||
        (v.password != null &&
          (typeof v.password !== "string" ||
            (v.password !== "" && !validPassword(v.password)))) ||
        (v.active != null && typeof v.active !== "boolean")
      )
        fail(400, "invalid user");
      const encrypted = v.password
        ? await passwordHash(v.password, 10)
        : undefined;
      v.active ??= false;
      db.transaction(() => {
        const old = db.get<any>(
          "SELECT role,active FROM users WHERE id=?",
          c.params.id,
        );
        if (!old) fail(404, "user not found");
        if (
          old.role === "admin" &&
          old.active &&
          (!v.active || v.role !== "admin") &&
          db.get<any>(
            "SELECT count(*) n FROM users WHERE role='admin' AND active=1",
          )!.n < 2
        )
          fail(409, "不能禁用或降级最后一个管理员");
        try {
          db.run(
            "UPDATE users SET name=?,role=?,active=? WHERE id=?",
            v.name,
            v.role,
            v.active,
            c.params.id,
          );
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.includes("UNIQUE constraint failed: users.name")
          )
            fail(409, "用户名已存在");
          throw error;
        }
        if (encrypted)
          db.run(
            "UPDATE users SET password_hash=? WHERE id=?",
            encrypted,
            c.params.id,
          );
        db.run("DELETE FROM sessions WHERE user_id=?", c.params.id);
      });
      c.json({ ok: true });
    });
    this.registerKeys();
    this.registerExemptTables();
    registerProfiles(this);
    registerOAuth(this);
  }
  private registerKeys() {
    const db = this.db,
      r = this.router;
    r.get("/api/v1/keys", (c) => {
      this.requireAdmin(c);
      c.json(
        db
          .all<any>(
            "SELECT id,name,active,created_at,COALESCE(last_used,'') last_used,upload_batches,error_count FROM ingest_keys ORDER BY created_at DESC",
          )
          .map(row => ({
            ...row,
            active: !!row.active,
          })),
      );
    });
    r.post("/api/v1/keys", async (c) => {
      this.requireAdmin(c);
      const v = record(await c.body());
      keyFields(v, ['name']);
      if (typeof v.name !== "string" || !v.name.trim())
        fail(400, "Key 名称必填");
      const uid = id(),
        key = "lm_" + token(),
        name = v.name.trim();
      db.run(
        "INSERT INTO ingest_keys(id,name,token_hash,created_at) VALUES(?,?,?,?)",
        uid,
        name,
        hash(key),
        new Date().toISOString(),
      );
      c.json(
        {
          id: uid,
          key,
          name,
        },
        201,
      );
    });
    r.put("/api/v1/keys/:id", async (c) => {
      this.requireAdmin(c);
      const v = record(await c.body());
      keyFields(v, ['name','active']);
      db.transaction(() => {
        const old = db.get<any>(
          "SELECT * FROM ingest_keys WHERE id=?",
          c.params.id,
        );
        if (!old) fail(404, "Key 不存在");
        const name = (v.name ?? old.name).trim(),
          active = v.active ?? !!old.active;
        if (!name) fail(400, "Key 名称必填");
        db.run(
          "UPDATE ingest_keys SET name=?,active=? WHERE id=?",
          name,
          active,
          c.params.id,
        );
      });
      c.json({ ok: true });
    });
    r.get("/api/v1/keys/:id/events", (c) => {
      this.requireAdmin(c);
      c.json(
        db.all(
          "SELECT at,service,status,detail FROM key_events WHERE key_id=? ORDER BY id DESC LIMIT 200",
          c.params.id,
        ),
      );
    });
  }
  private registerExemptTables() {
    const db = this.db, r = this.router;
    const item = (name:string) => {
      const row = db.get<any>("SELECT * FROM sdk_exempt_tables WHERE name=?", name);
      if (!row) fail(404, "豁免表不存在");
      return {...row,active:!!row.active};
    };
    const fields = (v:Record<string,any>,create=false) => {
      if (Object.keys(v).some(key => !(create?["name","description","active"]:["description","active"]).includes(key)))
        fail(400, "无效的豁免表字段");
      if (v.description !== undefined && (typeof v.description !== "string" || v.description.length > 500))
        fail(400, "说明最长 500 个字符");
      if (v.active !== undefined && typeof v.active !== "boolean") fail(400, "启用状态必须是布尔值");
    };
    r.get("/api/v1/sdk-exempt-tables", c => c.json(
      db.all<any>("SELECT * FROM sdk_exempt_tables ORDER BY created_at DESC,name").map(row => ({...row,active:!!row.active})),
    ));
    r.post("/api/v1/sdk-exempt-tables", async c => {
      this.requireAdmin(c);
      const v = record(await c.body()); fields(v,true);
      const name = typeof v.name === "string" ? v.name.trim() : "";
      if (!validTable(name) || systemTable(name)) fail(400, "请填写合法的业务逻辑表名，最长 48 位，不带 log_/metric_/trace_ 前缀或系统表名");
      db.transaction(() => {
        if (db.get("SELECT 1 FROM sdk_exempt_tables WHERE name=?",name)) fail(409, "此表已在豁免名单中");
        if (db.get<{n:number}>("SELECT count(*) n FROM sdk_exempt_tables")!.n >= 200) fail(400, "最多配置 200 个豁免表");
        db.run("INSERT INTO sdk_exempt_tables(name,description,active,created_at) VALUES(?,?,?,?)",name,(v.description??"").trim(),v.active!==false,new Date().toISOString());
      });
      c.json(item(name),201);
    });
    r.put("/api/v1/sdk-exempt-tables/:name", async c => {
      this.requireAdmin(c);
      const v=record(await c.body()); fields(v);
      const old=item(c.params.name);
      db.run("UPDATE sdk_exempt_tables SET description=?,active=? WHERE name=?",v.description===undefined?old.description:v.description.trim(),v.active??old.active,c.params.name);
      c.json(item(c.params.name));
    });
    r.delete("/api/v1/sdk-exempt-tables/:name", c => {
      this.requireAdmin(c); item(c.params.name);
      db.run("DELETE FROM sdk_exempt_tables WHERE name=?",c.params.name);
      c.json({ok:true});
    });
  }
}
