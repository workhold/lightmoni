import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, Server } from "node:net";
import { createSocket, Socket } from "node:dgram";
import { once } from "node:events";
import { availablePort } from "../src/operations/host-ports.js";
import { installCause } from "../src/operations/install-progress.js";
import { installDiagnostic } from "../../web/src/app/ops/install-state.js";

const signal = () => new AbortController().signal;

test("real TCP and UDP conflicts are rejected and released ports can be probed repeatedly", async () => {
  for (const protocol of ["tcp", "udp"]) {
    const listener = protocol === "tcp" ? createServer() : createSocket("udp4");
    if (listener instanceof Server) listener.listen(0, "127.0.0.1");
    else listener.bind(0, "127.0.0.1");
    await once(listener, "listening");
    const address = listener.address();
    assert.ok(address && typeof address !== "string");
    const port = { host_port: address.port, host_ip: "127.0.0.1", protocol };
    try {
      await assert.rejects(availablePort(port, signal()), { message: "HOST_PORT_OCCUPIED" });
    } finally {
      await new Promise<void>(resolve => listener.close(() => resolve()));
    }
    await availablePort(port, signal());
    await availablePort(port, signal());
  }
});

test("TCP and UDP low-port permission denial defers to Docker; other bind failures remain failures", async (t) => {
  for (const protocol of ["tcp", "udp"]) {
    for (const host_ip of ["0.0.0.0", "::", "::1"]) {
      for (const [host_port, code, expected] of [
        [80, "EACCES", ""],
        [443, "EACCES", ""],
        [1023, "EACCES", ""],
        [1024, "EACCES", "HOST_PORT_CHECK_FAILED"],
        [18080, "EACCES", "HOST_PORT_CHECK_FAILED"],
        [80, "EADDRINUSE", "HOST_PORT_OCCUPIED"],
        [18080, "EADDRINUSE", "HOST_PORT_OCCUPIED"],
        [80, "EADDRNOTAVAIL", "HOST_PORT_CHECK_FAILED"],
        [80, "EPERM", "HOST_PORT_CHECK_FAILED"],
      ] as const) {
        await t.test(`${protocol} ${host_ip}:${host_port} ${code}`, async (t) => {
          const fail = function (this: Server | Socket) {
            if (this instanceof Socket) assert.equal(this.type, host_ip.includes(":") ? "udp6" : "udp4");
            queueMicrotask(() => this.emit("error", Object.assign(Error("hidden host detail"), { code })));
            return this;
          };
          if (protocol === "tcp") t.mock.method(Server.prototype, "listen", fail);
          else t.mock.method(Socket.prototype, "bind", fail);
          const probe = availablePort({ host_port, host_ip, protocol }, signal());
          if (!expected) await probe;
          else await assert.rejects(probe, (error: Error) => {
            assert.equal(error.message, expected);
            assert.doesNotMatch(error.message, /hidden/);
            return true;
          });
        });
      }
    }
  }
});

test("an already cancelled operation never starts a listener", async (t) => {
  const listen = t.mock.method(Server.prototype, "listen");
  await assert.rejects(availablePort(
    { host_port: 80, host_ip: "0.0.0.0", protocol: "tcp" },
    AbortSignal.abort(),
  ), { name: "AbortError" });
  assert.equal(listen.mock.callCount(), 0);
});

test("unverified port failures have a safe cause and actionable Chinese and English copy", () => {
  assert.equal(installCause(Error("HOST_PORT_CHECK_FAILED")), "host_port_check_failed");
  const copy = installDiagnostic("host_port_check_failed");
  assert.match(copy[0], /检查失败/);
  assert.match(copy[1], /check failed/);
  assert.match(copy[2], /Agent.*权限.*监听地址/);
  assert.match(copy[3], /permissions.*bind address/);
});
