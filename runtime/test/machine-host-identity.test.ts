import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import ssh2 from "ssh2";
import { DB } from "../src/shared/sqlite.js";
import { Router, fail } from "../src/shared/http.js";
import { cipher } from "../src/shared/crypto.js";
import type { Dependencies } from "../src/shared/types.js";
import { registerManagedMachines } from "../src/server/managed-machines.js";
import { createAgentHostSchema } from "../src/server/agent-hosts.js";
import { recordMachineHostKey, sshHostIdentity } from "../src/server/machine-host-keys.js";
import { defaultSSHRunner } from "../src/server/machine-ssh.js";

const output = "LMSSH=1\nplatform=linux\narch=amd64\nlinux=1\nsupported_arch=1\ncurl=1\ntar=1\ngzip=1\nsha256sum=1\nsystemd=1\ninstall_privilege=1\nplatform_https=1\nagent_installation=absent\n";
const newKey = () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs1" }, publicKeyEncoding: { format: "pem", type: "pkcs1" } });
  const parsed = ssh2.utils.parseKey(pair.privateKey);
  if (parsed instanceof Error || Array.isArray(parsed)) throw Error("invalid fixture key");
  return { secret: pair.privateKey, parsed, raw: parsed.getPublicSSH(), ...sshHostIdentity(parsed.getPublicSSH()) };
};
const firstKey = newKey(), otherKey = newKey(), userKey = newKey();
async function sshFixture(t: TestContext) {
  const password = randomBytes(24).toString("base64url"), clients = new Set<any>(), commands: string[] = [], auth: string[] = [];
  let hold: ((accept: () => void) => void) | undefined;
  const server = new ssh2.Server({ hostKeys: [firstKey.secret] }, client => {
    clients.add(client); client.on("close", () => clients.delete(client)); client.on("error", () => {});
    client.on("authentication", context => {
      auth.push(context.method);
      const accepted = context.method === "password" && context.username === "fixture" && context.password === password || context.method === "publickey" && context.username === "fixture" && context.key.data.equals(userKey.raw) && (!context.signature || userKey.parsed.verify(context.blob!, context.signature, context.hashAlgo) === true);
      if (!accepted) { context.reject(["password", "publickey"]); return; }
      if (hold) hold(() => context.accept()); else context.accept();
    });
    client.on("ready", () => client.on("session", accept => {
      const session = accept(); session.on("exec", (accept, _reject, info) => {
        commands.push(info.command); const stream = accept(); stream.write(output); stream.exit(0); stream.end();
      });
    }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { for (const client of clients) client.end(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { port: (server.address() as {port:number}).port, password, commands, auth, setHold(value: typeof hold) { hold = value; } };
}
async function platform(t: TestContext) {
  const db = new DB(":memory:"), router = new Router(), user = { id: "admin", name: "Admin", role: "admin" };
  db.exec("CREATE TABLE agents(id TEXT PRIMARY KEY,last_seen TEXT NOT NULL DEFAULT '')");
  const deps = { db, router, ...cipher(Buffer.alloc(32, 5)), now: () => new Date(), externalURL: "https://platform.example.test", auth: { user: () => user, requireAdmin(ctx: any) { if (ctx.user.role !== "admin") fail(403, "administrator required"); } }, logger: { info() {}, warn() {}, error() {} } } as unknown as Dependencies;
  router.auth = deps.auth; const machines = registerManagedMachines(deps);
  const server = createServer(async (req, res) => { if (!await router.handle(req, res)) { res.writeHead(404); res.end(); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { machines.close?.(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); });
  const origin = `http://127.0.0.1:${(server.address() as {port:number}).port}/api/v1`;
  const request = async (path: string, method = "GET", body?: unknown) => { const response = await fetch(origin + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, data: await response.json() as any }; };
  const host = async (port: number, method: "password" | "ssh_key" = "password", password = "fixture-password") => {
    const made = await request("/machines", "POST", { name: "Fixture", address: "127.0.0.1", port, username: "fixture" }); assert.equal(made.status, 201);
    const credential = await request(`/machines/${made.data.id}/credentials`, "POST", { method, secret: method === "password" ? password : userKey.secret, confirm_managed: true }); assert.equal(credential.status, 201);
    return { id: made.data.id, cid: credential.data.credential_id, initial: made.data };
  };
  return { db, machines, request, host };
}

test("password and private-key first preflights record their handshake key and keep checks/plans usable", async t => {
  const ssh = await sshFixture(t), f = await platform(t);
  for (const method of ["password", "ssh_key"] as const) {
    const h = await f.host(ssh.port, method, ssh.password);
    assert.equal(h.initial.host_key_fingerprint, ""); assert.equal(h.initial.host_key_public_key, "");
    assert.equal(f.machines.get(h.id).capabilities.ssh_check.available, true);
    const check = await f.request(`/machines/${h.id}/ssh-check`, "POST", { credential_id: h.cid }); assert.equal(check.status, 200); assert.equal(check.data.ready, true, JSON.stringify(check.data));
    const learned = f.machines.get(h.id); assert.equal(learned.host_key_fingerprint, firstKey.fingerprint); assert.equal(learned.host_key_public_key, firstKey.publicKey); assert.equal(learned.host_key_status, "observed"); assert.ok(learned.host_key_observed_at);
    const plan = await f.request(`/machines/${h.id}/deployments/plan`, "POST", { check_id: check.data.id, credential_id: h.cid, version: "0.1.0", arch: "amd64" }); assert.equal(plan.status, 201, JSON.stringify(plan.data));
    const assistant = f.machines.assistantGet(h.id); assert.equal(assistant.host_key_public_key, ""); assert.equal(assistant.host_key_fingerprint, "");
    const again = await f.request(`/machines/${h.id}/ssh-check`, "POST", { credential_id: h.cid }); assert.equal(again.data.ready, true); assert.equal(f.machines.get(h.id).host_key_observed_at, learned.host_key_observed_at);
  }
  assert.equal(ssh.commands.length, 4);
});

test("identity is server-owned; endpoint edits reset identity and permanently invalidate old checks and plans", async t => {
  const ssh = await sshFixture(t), f = await platform(t), h = await f.host(ssh.port, "password", ssh.password);
  for (const field of ["host_key_fingerprint", "host_key_public_key", "host_key_observed_at", "host_key_status", "ssh_target_generation"]) {
    assert.equal((await f.request("/machines", "POST", { name: "bad", address: "127.0.0.1", username: "fixture", [field]: "injected" })).status, 400);
    assert.equal((await f.request(`/machines/${h.id}`, "PUT", { [field]: "injected" })).status, 400);
  }
  const check = await f.request(`/machines/${h.id}/ssh-check`, "POST", { credential_id: h.cid });
  const plan = await f.request(`/machines/${h.id}/deployments/plan`, "POST", { check_id: check.data.id, credential_id: h.cid, version: "0.1.0", arch: "amd64" }); assert.equal(plan.status, 201);
  const learned = f.machines.get(h.id), lease = f.machines.acquireTerminal(h.id, h.cid, () => {}); lease.release();
  assert.equal((await f.request(`/machines/${h.id}`, "PUT", { username: "another-account" })).status, 200); assert.equal(f.machines.get(h.id).host_key_public_key, firstKey.publicKey);
  assert.equal((await f.request(`/machines/${h.id}`, "PUT", { username: "fixture", port: ssh.port + 1 })).status, 200); assert.equal(f.machines.get(h.id).host_key_public_key, ""); assert.equal(f.machines.get(h.id).host_key_fingerprint, "");
  assert.equal((await f.request(`/machines/${h.id}`, "PUT", { port: ssh.port })).status, 200);
  const fresh = await f.request(`/machines/${h.id}/ssh-check`, "POST", { credential_id: h.cid }); assert.equal(fresh.data.ready, true);
  assert.notEqual(f.machines.get(h.id).ssh_target_generation, learned.ssh_target_generation);
  assert.equal(f.db.get<any>("SELECT status FROM machine_deployments WHERE id=?", plan.data.id)?.status, "cancelled");
  assert.equal((await f.request(`/machines/${h.id}/deployments/plan`, "POST", { check_id: check.data.id, credential_id: h.cid, version: "0.1.0", arch: "amd64" })).status, 404);
});

test("existing matching pins are completed, mismatch preserves them and sends no credentials or commands", async t => {
  const ssh = await sshFixture(t), f = await platform(t), h = await f.host(ssh.port, "password", ssh.password);
  f.db.run("UPDATE managed_machines SET host_key_fingerprint=? WHERE id=?", otherKey.fingerprint, h.id);
  const authCount = ssh.auth.length;
  const mismatch = await f.request(`/machines/${h.id}/ssh-check`, "POST", { credential_id: h.cid }); assert.equal(mismatch.data.error_code, "host_key_mismatch"); assert.equal(ssh.auth.length, authCount); assert.equal(ssh.commands.length, 0); assert.equal(f.machines.get(h.id).host_key_fingerprint, otherKey.fingerprint); assert.equal(f.machines.get(h.id).host_key_public_key, "");
  f.db.run("UPDATE managed_machines SET host_key_fingerprint=? WHERE id=?", firstKey.fingerprint, h.id);
  const matched = await f.request(`/machines/${h.id}/ssh-check`, "POST", { credential_id: h.cid }); assert.equal(matched.data.ready, true); assert.equal(f.machines.get(h.id).host_key_public_key, firstKey.publicKey);
});

test("atomic first-key recording rejects conflicting, stale, deleted and unauthorized targets", () => {
  const db = new DB(":memory:"); try {
    createAgentHostSchema(db); db.run("INSERT INTO managed_machines(id,name,address,port,username,connection_method,created_at,updated_at) VALUES('host','Host','127.0.0.1',22,'root','direct_ssh','now','now')");
    const original = db.get<any>("SELECT * FROM managed_machines WHERE id='host'")!, contender = {...original};
    assert.equal(recordMachineHostKey(db, original, firstKey.raw, "first"), true); assert.equal(recordMachineHostKey(db, contender, otherKey.raw, "second"), false);
    assert.equal(recordMachineHostKey(db, {...contender}, firstKey.raw, "second"), true);
    assert.equal(db.get<any>("SELECT * FROM managed_machines WHERE id='host'")!.host_key_observed_at, "first");
    db.run("UPDATE managed_machines SET ssh_target_generation=ssh_target_generation+1 WHERE id='host'"); assert.equal(recordMachineHostKey(db, original, firstKey.raw, "late"), false);
    const fresh = db.get<any>("SELECT * FROM managed_machines WHERE id='host'")!; assert.equal(recordMachineHostKey(db, fresh, firstKey.raw, "late", () => false), false);
    db.run("DELETE FROM managed_machines WHERE id='host'"); assert.equal(recordMachineHostKey(db, fresh, firstKey.raw, "late"), false);
  } finally { db.close(); }
});

test("host-key verification ignores user labels but still rejects a different login target", () => {
  const db=new DB(":memory:");try{
    createAgentHostSchema(db);
    db.run("INSERT INTO managed_machines(id,name,address,port,username,connection_method,created_at,updated_at) VALUES('host','Original label','127.0.0.1',22,'root','direct_ssh','now','now')");
    const expected=db.get<any>("SELECT * FROM managed_machines WHERE id='host'")!;
    db.run("UPDATE managed_machines SET name='New user label' WHERE id='host'");
    assert.equal(recordMachineHostKey(db,expected,firstKey.raw,"first"),true);
    assert.equal(db.get<any>("SELECT name FROM managed_machines WHERE id='host'")!.name,"New user label");
    db.run("UPDATE managed_machines SET username='different-login' WHERE id='host'");
    assert.equal(recordMachineHostKey(db,expected,firstKey.raw,"later"),false);
  }finally{db.close();}
});

test("revocation, expiry, cancellation and target mutation during delayed authentication cannot execute a command", async t => {
  for (const mutation of ["revoke", "endpoint", "expiry", "cancel"] as const) {
    const ssh = await sshFixture(t), f = await platform(t), h = await f.host(ssh.port, "password", ssh.password);
    let release!: () => void; const held = new Promise<void>(resolve => ssh.setHold(accept => { release = accept; resolve(); }));
    const controller = new AbortController();
    const pending = f.machines.checkSSH(h.id, { credential_id: h.cid }, "admin", controller.signal); await held;
    if (mutation === "revoke") await f.request(`/machines/${h.id}/credentials/${h.cid}`, "DELETE");
    else if (mutation === "expiry") f.db.run("UPDATE machine_credentials SET expires_at=? WHERE id=?", new Date(Date.now() - 1000).toISOString(), h.cid);
    else if (mutation === "cancel") controller.abort();
    else f.db.run("UPDATE managed_machines SET address='changed.example.test',ssh_target_generation=ssh_target_generation+1 WHERE id=?", h.id);
    if (mutation !== "cancel") release(); const check = await pending; assert.equal(check.ready, false); assert.equal(ssh.commands.length, 0);
  }
});

test("cancelled first connection and invalid login cannot execute a command", async t => {
  const ssh = await sshFixture(t), f = await platform(t), h = await f.host(ssh.port, "password", "incorrect-password");
  const bad = await f.request(`/machines/${h.id}/ssh-check`, "POST", { credential_id: h.cid }); assert.equal(bad.data.ready, false); assert.equal(ssh.commands.length, 0);
  const cancel = new AbortController(); cancel.abort();
  await assert.rejects(() => defaultSSHRunner({ machine: f.machines.get(h.id), privateKey: "", password: ssh.password, command: "unused", signal: cancel.signal, port: ssh.port }), /cancelled/);
  assert.equal(ssh.commands.length, 0);
});


test("separate processes race to one first identity and recheck authorization after waiting for the database lock", async t => {
  const directory = await mkdtemp(join(tmpdir(), "lightmoni-host-key-race-")), path = join(directory, "state.db");
  t.after(() => rm(directory, {recursive:true,force:true}));
  const db = new DB(path); t.after(() => db.close()); createAgentHostSchema(db);
  db.run("INSERT INTO managed_machines(id,name,address,port,username,connection_method,created_at,updated_at) VALUES('host','Host','127.0.0.1',22,'root','direct_ssh','now','now')");
  const worker = (mode: string) => {
    const child = fork(fileURLToPath(new URL("./helpers/host-key-race-worker.ts", import.meta.url)), [path, mode], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "inherit", "ipc"] });
    t.after(() => { if (child.connected) child.disconnect(); child.kill(); }); return child;
  };
  const one = worker("race"), two = worker("race");
  await Promise.all([once(one, "message"), once(two, "message")]);
  const results = [once(one, "message"), once(two, "message")];
  one.send({key:firstKey.raw.toString("base64")}); two.send({key:otherKey.raw.toString("base64")});
  const accepted = (await Promise.all(results)).map(([message]) => message.result);
  assert.deepEqual(accepted.sort(), [false,true]);
  const saved = db.get<any>("SELECT * FROM managed_machines WHERE id='host'")!;
  assert.ok([firstKey.fingerprint,otherKey.fingerprint].includes(saved.host_key_fingerprint));
  db.exec("CREATE TABLE test_authorization(active INTEGER NOT NULL);INSERT INTO test_authorization VALUES(1)");
  const lock = worker("revoke"); await once(lock, "message");
  const raw = saved.host_key_fingerprint === firstKey.fingerprint ? firstKey.raw : otherKey.raw;
  assert.equal(recordMachineHostKey(db, saved, raw, "after-wait", () => db.get<any>("SELECT active FROM test_authorization")?.active === 1), false);
  assert.equal(db.get<any>("SELECT active FROM test_authorization")?.active, 0);
});
