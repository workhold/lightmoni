import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "../src/shared/http.js";
import { listenAddress } from "../src/server/address.js";

test("Agent CLI executes through an installed current-release symlink", () => {
  const directory = mkdtempSync(join(tmpdir(), "lightmoni-cli-link-"));
  try {
    const link = join(directory, "entry.ts");
    symlinkSync(
      fileURLToPath(new URL("../src/agent/main.ts", import.meta.url)),
      link,
    );
    assert.equal(
      execFileSync(process.execPath, ["--import", "tsx", link, "version"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
      }).trim(),
      "0.1.0",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("origin validation accepts local aliases and rejects malformed or cross-site origins", () => {
  const router = new Router();
  router.externalURL = "http://127.0.0.1:8080";
  const check = (origin: string) =>
    router.checkOrigin({ method: "POST", headers: { origin } } as any);
  for (const origin of [
    "http://127.0.0.1:8080",
    "http://localhost:8080",
    "http://localhost:5173",
    "http://[::1]:8080",
  ])
    assert.doesNotThrow(() => check(origin));
  for (const origin of [
    "null",
    "https://evil.test",
    "http://localhost:8081",
    "https://localhost:8080",
    "http://user@localhost:8080",
    "http://localhost:8080/path",
    "http://localhost:8080?x=1",
    "http://localhost:8080/#fragment",
  ])
    assert.throws(() => check(origin), /invalid request origin/);
  router.externalURL = "https://monitor.example.com";
  assert.doesNotThrow(() => check("https://monitor.example.com"));
  assert.throws(() => check("http://localhost:5173"));
});

test("listen configuration rejects malformed ports before initializing state", () => {
  assert.deepEqual(listenAddress(":8080"), { host: "0.0.0.0", port: 8080 });
  assert.deepEqual(listenAddress("[::1]:18885"), { host: "::1", port: 18885 });
  for (const raw of [
    "8080",
    "localhost",
    "[::1]8080",
    "host:0",
    "host:65536",
    "host:NaN",
    "host:1.5",
    "::1:8080",
  ])
    assert.throws(() => listenAddress(raw));
});

test(
  "failed server bind closes background modules and exits without a leaked scheduler",
  { timeout: 15000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "lightmoni-startup-"));
    const ch = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end('{"meta":[],"data":[],"rows":0}');
    });
    const occupied = createServer();
    await Promise.all([
      new Promise<void>((r) => ch.listen(0, "127.0.0.1", r)),
      new Promise<void>((r) => occupied.listen(0, "127.0.0.1", r)),
    ]);
    let output = "";
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("../src/server/main.ts", import.meta.url)),
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: {
          ...process.env,
          LIGHTMONI_ADDR: "127.0.0.1:" + (occupied.address() as any).port,
          LIGHTMONI_DATA: directory,
          LIGHTMONI_CH_URL: "http://127.0.0.1:" + (ch.address() as any).port,
          LIGHTMONI_CH_PASSWORD: "fixture-only",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (output += data));
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      const [code, signal] = await once(child, "exit");
      assert.equal(signal, null, output);
      assert.equal(code, 1, output);
      assert.match(output, /EADDRINUSE/);
    } finally {
      clearTimeout(timer);
      child.kill();
      ch.closeAllConnections();
      occupied.closeAllConnections();
      await Promise.all([
        new Promise<void>((r) => ch.close(() => r())),
        new Promise<void>((r) => occupied.close(() => r())),
      ]);
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
