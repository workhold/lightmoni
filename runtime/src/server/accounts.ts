import { hash as passwordHash } from "bcryptjs";
import { initializeCenterSchema } from "./schema.js";
import { id } from "../shared/crypto.js";
import type { DB } from "../shared/sqlite.js";

export const validPassword = (s: unknown): s is string =>
  typeof s === "string" && [...s].length >= 8 && Buffer.byteLength(s) <= 72;

export function accountSchema(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL DEFAULT '',role TEXT NOT NULL DEFAULT 'member',active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at INTEGER NOT NULL);`);
}

export class AdminError extends Error {}

export async function writeAdmin(db: DB, action: "init" | "reset-password", name: string, password: string): Promise<void> {
  if (!name.trim() || /[\x00-\x1f\x7f]/u.test(name)) throw new AdminError("请提供有效的管理员名称");
  if (!validPassword(password)) throw new AdminError("密码至少 8 个字符且最多 72 个 UTF-8 字节");
  const encrypted = await passwordHash(password, 10);
  db.transaction(() => {
    initializeCenterSchema(db);
    if (action === "init") {
      accountSchema(db);
      if (db.get<{ n: number }>("SELECT count(*) n FROM users")!.n !== 0)
        throw new AdminError("已有用户，不能重复初始化；请使用 reset-password 重置管理员密码");
      db.run("INSERT INTO users(id,name,password_hash,role,active,created_at) VALUES(?,?,?,'admin',1,?)", id(), name, encrypted, new Date().toISOString());
    } else {
      const user = db.get<{ id: string; role: string }>("SELECT id,role FROM users WHERE name=?", name);
      if (!user || user.role !== "admin") throw new AdminError("指定名称不是已有管理员");
      db.run("UPDATE users SET password_hash=? WHERE id=?", encrypted, user.id);
      db.run("DELETE FROM sessions WHERE user_id=?", user.id);
    }
  });
}
