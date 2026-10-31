import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import si from "systeminformation";
import type { Attributes, LightMoni } from "@lightmoni/sdk";
import { Collector } from "../src/agent/collect.js";
import type { RemoteConfig } from "../src/agent/config.js";

type Measurement = { name: string; value: number | bigint; attributes: Attributes };
function fixture(t: any, platform = "linux") {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  const metrics: Measurement[] = [], states: { name: string; message: string }[] = [];
  const client = {
    gauge: (name: string) => ({ record(value: number, attributes: Attributes = {}) { metrics.push({ name, value, attributes }); } }),
    counter: (name: string) => ({ add(value: bigint, attributes: Attributes = {}) { metrics.push({ name, value, attributes }); } }),
  } as unknown as LightMoni;
  const collector = new Collector(client, "fixture-host", (name, message) => states.push({ name, message }));
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", descriptor);
  });
  const collect = (patterns: string[]) => collector.collect({ host_enabled: true, host_collectors: ["process"], process_names: patterns } as RemoteConfig, () => ({}));
  return { collector, metrics, states, collect };
}

function linuxProcesses(t: any, names: string[]) {
  let cpuTicks = 10;
  const unreadableFDs = new Set<number>(), unreadableNames = new Set<number>(), reads = new Map<string, number>();
  const read = fs.readFileSync as (...args: any[]) => any;
  const readdir = fs.readdirSync as (...args: any[]) => any;
  t.mock.method(fs, "readFileSync", (...args: any[]) => {
    const path = String(args[0]);
    if (path === "/proc/stat") return "btime 100\n";
    const match = /^\/proc\/(\d+)\/(comm|stat|status)$/.exec(path);
    if (!match) return read(...args);
    const pid = Number(match[1]);
    reads.set(path, (reads.get(path) ?? 0) + 1);
    if (match[2] === "comm") {
      if (unreadableNames.has(pid)) throw Object.assign(Error("fixture inaccessible process name"), { code: "EACCES" });
      return names[pid - 1] + "\n";
    }
    if (match[2] === "status") return "VmRSS:\t1024 kB\n";
    const fields = Array(22).fill("0");
    fields[0] = "S";
    fields[11] = String(cpuTicks);
    fields[12] = "2";
    fields[17] = "3";
    fields[19] = "100";
    return `${pid} (${names[pid - 1]}) ${fields.join(" ")}`;
  });
  t.mock.method(fs, "readdirSync", (...args: any[]) => {
    const path = String(args[0]);
    if (path === "/proc") return names.map((_, index) => String(index + 1));
    const match = /^\/proc\/(\d+)\/fd$/.exec(path);
    if (!match) return readdir(...args);
    if (unreadableFDs.has(Number(match[1]))) throw Object.assign(Error("fixture inaccessible file descriptors"), { code: "EACCES" });
    return ["0", "1", "2"];
  });
  t.mock.method(childProcess, "execFileSync", () => "100\n");
  syncBuiltinESMExports();
  return { unreadableFDs, unreadableNames, reads, advance() { cpuTicks += 10; } };
}

test("overlapping Linux matchers each receive process metrics and independent CPU deltas", async t => {
  const f = fixture(t), processes = linuxProcesses(t, ["node"]);
  await f.collect(["*", "node"]);
  const running = f.metrics.filter(value => value.name === "process.matcher.running");
  assert.deepEqual(running.map(value => [value.attributes.matcher, value.value]), [["*", 1], ["node", 1]]);
  processes.advance();
  await f.collect(["*", "node"]);
  const cpu = f.metrics.filter(value => value.name === "process.cpu.time");
  assert.deepEqual(cpu.map(value => [value.attributes.matcher, value.value]), [["*", 100_000_000n], ["node", 100_000_000n]]);
  assert.equal(processes.reads.get("/proc/1/stat"), 2, "overlapping matchers read process state once per sample");
  assert.equal(processes.reads.get("/proc/1/status"), 2);
  assert(f.states.every(value => value.message === "ok"));
});

test("a full matcher does not consume a later matcher's independent eight-process budget", async t => {
  const f = fixture(t);
  linuxProcesses(t, [...Array(9).fill("node"), "nginx"]);
  await f.collect(["*", "nginx"]);
  const running = f.metrics.filter(value => value.name === "process.running");
  assert.equal(running.filter(value => value.attributes.matcher === "*").length, 8);
  assert.equal(running.filter(value => value.attributes.matcher === "nginx").length, 1);
  assert(f.metrics.some(value => value.name === "process.matcher.running" && value.attributes.matcher === "nginx" && value.value === 1));
});

test("unreadable process FDs report partial without inventing zero or discarding readable metrics", async t => {
  const f = fixture(t), processes = linuxProcesses(t, ["node"]);
  processes.unreadableFDs.add(1);
  await f.collect(["*", "node"]);
  assert.equal(f.metrics.filter(value => value.name === "process.file_descriptors").length, 0);
  assert.equal(f.metrics.filter(value => value.name === "process.memory.rss").length, 2);
  assert(f.metrics.filter(value => value.name === "process.memory.rss").every(value => value.value === 1024 * 1024));
  assert.equal(f.states.at(-1)?.message, "partial: 1 unavailable measurements, 0 unreadable process names");
  processes.advance();
  await f.collect(["*", "node"]);
  assert.deepEqual(f.metrics.filter(value => value.name === "process.cpu.time").map(value => value.value), [100_000_000n, 100_000_000n]);
  processes.unreadableFDs.clear();
  processes.advance();
  await f.collect(["*", "node"]);
  assert.equal(f.states.at(-1)?.message, "ok");
  assert.deepEqual(f.metrics.filter(value => value.name === "process.file_descriptors").map(value => value.value), [3, 3]);
});

test("an unreadable process name still avoids a false missing-process report", async t => {
  const f = fixture(t), processes = linuxProcesses(t, ["node"]);
  processes.unreadableNames.add(1);
  await f.collect(["node"]);
  assert(!f.metrics.some(value => value.name === "process.matcher.running"));
  assert.equal(f.states.at(-1)?.message, "partial: 0 unavailable measurements, 1 unreadable process names");
});

test("overlapping non-Linux matchers retain independent self-process CPU deltas", async t => {
  const f = fixture(t, "darwin");
  let user = 10;
  t.mock.method(si, "processes", async () => ({ list: [{ pid: process.pid, name: "node", started: "2026-11-01T00:00:00Z", memRss: 1024 }] }));
  t.mock.method(process, "cpuUsage", () => ({ user, system: 2 }));
  await f.collect(["*", "node"]);
  user += 10;
  await f.collect(["*", "node"]);
  assert.deepEqual(f.metrics.filter(value => value.name === "process.cpu.time").map(value => [value.attributes.matcher, value.value]), [["*", 10_000n], ["node", 10_000n]]);
  assert(f.metrics.filter(value => value.name === "process.matcher.running").every(value => value.value === 1));
  assert(f.states.every(value => value.message === "ok"));
});
