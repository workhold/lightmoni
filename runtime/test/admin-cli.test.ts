import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { compare } from "bcryptjs";
import { DB } from "../src/shared/sqlite.js";
import { Router } from "../src/shared/http.js";
import { Auth } from "../src/server/auth.js";

const cli = fileURLToPath(new URL("../src/server/admin-cli.ts", import.meta.url));
const run = (dir: string, args: string[], password: string | Buffer = "fixture-password\n") => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
  const child = spawn(process.execPath, ["--import", "tsx", cli, ...args], { env: { ...process.env, LIGHTMONI_DATA: dir }, stdio: "pipe" });
  let output = "";
  child.stdout.on("data", b => output += b);
  child.stderr.on("data", b => output += b);
  child.on("error", reject);
  child.on("close", code => resolve({ code, output }));
  child.stdin.on("error", () => {});
  child.stdin.end(password);
});
const args = (action = "init", name = "admin") => [action, "--name", name, "--password-stdin"];

test("admin CLI initializes once and reset works with HTTP login while invalidating only target sessions", async t => {
  const dir = mkdtempSync(join(tmpdir(), "lightmoni-admin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = await run(dir, args());
  assert.equal(first.code, 0, first.output);
  assert.ok(!first.output.includes("fixture-password"));
  assert.equal(existsSync(join(dir, "master.key")), false);
  const db = new DB(join(dir, "lightmoni.db"));
  t.after(() => db.close());
  const user = db.get<any>("SELECT * FROM users")!;
  assert.equal(user.role, "admin");
  assert.equal(user.active, 1);
  assert.ok(await compare("fixture-password", user.password_hash));
  assert.equal((await run(dir, args("init", "other"))).code, 1);
  assert.deepEqual(db.get("SELECT * FROM users"), user);
  const router = new Router(() => {}), auth = new Auth(db, dir, "http://127.0.0.1", router);
  router.auth = auth; auth.register();
  const server = createServer((req, res) => void router.handle(req, res));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  router.externalURL = base;
  const login = (password: string) => fetch(base + "/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "admin", password }) });
  const oldLogin = await login("fixture-password");
  assert.equal(oldLogin.status, 200);
  const cookie = oldLogin.headers.get("set-cookie")!.split(";")[0];
  db.run("INSERT INTO users(id,name,role,created_at) VALUES('member','member','member','fixture')");
  db.run("INSERT INTO sessions VALUES('member-session','member',9999999999)");
  const masterBefore = auth.master.toString("hex");
  const reset = await run(dir, args("reset-password"), "new-fixture-password\r\n");
  assert.equal(reset.code, 0, reset.output);
  assert.equal((await login("fixture-password")).status, 401);
  assert.equal((await fetch(base + "/api/v1/auth/me", { headers: { cookie } })).status, 401);
  assert.equal((await login("new-fixture-password")).status, 200);
  assert.ok(db.get("SELECT 1 FROM sessions WHERE token_hash='member-session'"));
  const beforeFailure = db.get<any>("SELECT password_hash FROM users WHERE id=?", user.id)!.password_hash;
  db.exec("CREATE TRIGGER reject_session_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  assert.equal((await run(dir, args("reset-password"), "rollback-fixture-password")).code, 1);
  assert.equal(db.get<any>("SELECT password_hash FROM users WHERE id=?", user.id)!.password_hash, beforeFailure);
  assert.ok(db.get("SELECT 1 FROM sessions WHERE user_id=?", user.id));
  db.exec("DROP TRIGGER reject_session_delete");
  assert.equal(auth.master.toString("hex"), masterBefore);
  assert.deepEqual(db.get("SELECT id,name,role,active,created_at FROM users WHERE id=?", user.id), { id: user.id, name: user.name, role: user.role, active: user.active, created_at: user.created_at });
  for (const name of ["missing", "member", "' OR 1=1 --"]) assert.equal((await run(dir, args("reset-password", name))).code, 1);
  db.run("UPDATE users SET active=0 WHERE id=?", user.id);
  assert.equal((await run(dir, args("reset-password"))).code, 0);
  assert.equal(db.get<any>("SELECT active FROM users WHERE id=?", user.id)!.active, 0);
});

test("CLI rejects invalid inputs before creating state and supports password byte boundaries", async t => {
  const dir = mkdtempSync(join(tmpdir(), "lightmoni-admin-input-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const argv of [[], ["init"], [...args(), "--password", "secret"], [...args(), "--name", "duplicate"], ["reset-password", "--name", "admin", "--password-stdin"], ["init", "--name", "admin"]]) {
    assert.equal((await run(join(dir, "missing"), argv)).code, 1);
    assert.equal(existsSync(join(dir, "missing")), false);
  }
  assert.equal((await run(dir, ["--help"])).code, 0);
  for (const password of ["", "short", "1234567", "x".repeat(73), "😀".repeat(19), "valid-password\nextra\n", Buffer.from([0xff, 0xfe])]) {
    const result = await run(dir, args(), password);
    assert.equal(result.code, 1, result.output);
    assert.equal(existsSync(join(dir, "lightmoni.db")), false);
  }
  assert.equal((await run(dir, args(), "😀".repeat(18) + "\n")).code, 0);
  assert.equal((await run(dir, args("reset-password"), "x".repeat(72))).code, 0);
});

test("concurrent initialization creates exactly one administrator", async t => {
  const dir = mkdtempSync(join(tmpdir(), "lightmoni-admin-race-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const results = await Promise.all([run(dir, args("init", "one")), run(dir, args("init", "two"))]);
  assert.deepEqual(results.map(r => r.code).sort(), [0, 1], JSON.stringify(results));
  const db = new DB(join(dir, "lightmoni.db"));
  try { assert.equal(db.get<any>("SELECT count(*) n FROM users")!.n, 1); } finally { db.close(); }
});
