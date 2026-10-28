import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import ssh2 from "ssh2";
import { passwordSSHRunner } from "../src/server/machine-ssh.js";
import type { MachineSummary } from "../src/server/managed-machines.js";

// A real SSH protocol fixture on loopback verifies password authentication
// without creating a local OS user or touching the user's SSH service/config.
test("one-time password SSH runner pins the host and handles authentication, timeout and cancellation", async t => {
  const { Server, utils } = ssh2;
  const key = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs1" }, publicKeyEncoding: { format: "pem", type: "pkcs1" } });
  const parsed = utils.parseKey(key.privateKey);
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error("fixture host key invalid");
  const fingerprint = "SHA256:" + createHash("sha256").update(parsed.getPublicSSH()).digest("base64").replace(/=+$/, "");
  const password = randomBytes(24).toString("base64url"), commands: string[] = [];
  let waiting: (() => void) | undefined;
  const connections = new Set<any>();
  const server = new Server({ hostKeys: [key.privateKey] }, client => {
    connections.add(client); client.on("close", () => connections.delete(client));
    client.on("error", () => {});
    client.on("authentication", context => {
      if (context.method === "password" && context.username === "fixture" && context.password === password) context.accept();
      else context.reject(["password"]);
    });
    client.on("ready", () => client.on("session", accept => {
      const session = accept();
      session.on("exec", (accept, _reject, info) => {
        const channel = accept(); commands.push(info.command);
        if (info.command === "fixture-wait") { waiting?.(); return; }
        channel.write("LMSSH=1\n"); channel.stderr.write("fixture bounded warning\n"); channel.exit(0); channel.end();
      });
    }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { for (const client of connections) client.end(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as { port: number }).port;
  const input = { machine: { address: "127.0.0.1", username: "fixture", host_key_fingerprint: fingerprint } as MachineSummary,
    password, privateKey: "", command: "fixture-preflight", signal: new AbortController().signal, port, timeoutMs: 1000 };
  const result = await passwordSSHRunner(input);
  assert.equal(result.stdout, "LMSSH=1\n"); assert.equal(result.stderr, "fixture bounded warning\n");
  assert.deepEqual(commands, ["fixture-preflight"]); assert.ok(result.stages.includes("host_key_confirmed"));
  await assert.rejects(() => passwordSSHRunner({ ...input, password: "incorrect" }), /ssh_failed/);
  await assert.rejects(() => passwordSSHRunner({ ...input, machine: { ...input.machine, host_key_fingerprint: "SHA256:wrong-confirmed-key" } }), /host_key_mismatch/);
  assert.equal(commands.length, 1, "failed authentication and host pin must not execute a command");
  await assert.rejects(() => passwordSSHRunner({ ...input, command: "fixture-wait", timeoutMs: 250 }), /timed_out/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => passwordSSHRunner({ ...input, signal: controller.signal }), /cancelled/);
  const during = new AbortController(), entered = new Promise<void>(resolve => { waiting = resolve; });
  const pending = passwordSSHRunner({ ...input, command: "fixture-wait", signal: during.signal });
  await entered; during.abort();
  await assert.rejects(() => pending, /cancelled/);
  assert.deepEqual(commands, ["fixture-preflight", "fixture-wait", "fixture-wait"]);
  assert.ok(!JSON.stringify(result).includes(password), "runner output must not contain a credential");
});
