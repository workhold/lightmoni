import * as os from "node:os";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import si from "systeminformation";
import type { LightMoni, Attributes, Gauge, Counter } from "@lightmoni/sdk";
import type { RemoteConfig } from "./config.js";
import { glob } from "./config.js";
export class Collector {
  private gauges = new Map<string, Gauge>();
  private counters = new Map<string, Counter>();
  private previous = new Map<string, bigint>();
  private cpu: { idle: number; total: number } | undefined;
  constructor(
    readonly client: LightMoni,
    readonly hostID: string,
    readonly status: (name: string, message: string) => void,
  ) {}
  gauge(name: string, unit: string, value: number, attrs: Attributes = {}) {
    if (!Number.isFinite(value)) return;
    let g = this.gauges.get(name);
    if (!g) {
      g = this.client.gauge(name, { unit });
      this.gauges.set(name, g);
    }
    g.record(value, attrs);
  }
  delta(
    name: string,
    unit: string,
    source: string,
    current: bigint,
    attrs: Attributes,
  ) {
    const previous = this.previous.get(source);
    this.previous.set(source, current);
    if (
      previous === undefined ||
      current < previous ||
      current - previous > (1n << 63n) - 1n
    )
      return;
    let counter = this.counters.get(name);
    if (!counter) {
      counter = this.client.counter(name, { unit });
      this.counters.set(name, counter);
    }
    counter.add(current - previous, attrs);
  }
  async collect(
    tasks: RemoteConfig,
    queueStats: () => any,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!tasks.host_enabled) return;
    const selected = new Set(tasks.host_collectors),
      attrs = { host_id: this.hostID };
    const run = async (name: string, action: () => void | Promise<void>) => {
      if (signal?.aborted) return;
      try {
        await action();
        this.status(name, "ok");
      } catch (e) {
        this.status(name, String((e as Error).message));
      }
    };
    if (selected.has("cpu"))
      await run("cpu", () => {
        let idle = 0,
          total = 0;
        for (const c of os.cpus()) {
          idle += c.times.idle;
          total += Object.values(c.times).reduce((a, b) => a + b, 0);
        }
        if (this.cpu && total > this.cpu.total)
          this.gauge(
            "host.cpu.utilization",
            "1",
            1 - (idle - this.cpu.idle) / (total - this.cpu.total),
            attrs,
          );
        this.cpu = { idle, total };
      });
    if (selected.has("memory"))
      await run("memory", async () => {
        const m = await si.mem();
        if (signal?.aborted) return;
        this.gauge("host.memory.used", "By", m.active, attrs);
        this.gauge("host.memory.available", "By", m.available, attrs);
        this.gauge("host.memory.total", "By", m.total, attrs);
        this.gauge("host.swap.used", "By", m.swapused, attrs);
        this.gauge("host.swap.total", "By", m.swaptotal, attrs);
      });
    if (selected.has("system"))
      await run("system", () => {
        this.gauge("host.uptime", "s", os.uptime(), attrs);
        const load = os.loadavg();
        for (let i = 0; i < 3; i++)
          this.gauge("host.load.average", "1", load[i], {
            period: ["1m", "5m", "15m"][i],
          });
      });
    if (selected.has("filesystem"))
      await run("filesystem", async () => {
        const disks = await si.fsSize();
        if (signal?.aborted) return;
        for (const d of disks
          .filter((x) => !/^\/(proc|sys|dev\/)/.test(x.mount))
          .slice(0, 32)) {
          const a = { mountpoint: d.mount, filesystem: d.type };
          this.gauge("host.filesystem.used", "By", d.used, a);
          this.gauge("host.filesystem.total", "By", d.size, a);
        }
      });
    if (selected.has("disk"))
      await run("disk", async () => {
        if (process.platform === "linux") {
          let count = 0;
          for (const line of readFileSync("/proc/diskstats", "utf8")
            .trim()
            .split("\n")) {
            const p = line.trim().split(/\s+/);
            if (p.length < 10) continue;
            if (count++ >= 32) break;
            this.delta(
              "host.disk.io",
              "By",
              "diskread:" + p[2],
              BigInt(p[5]) * 512n,
              { device: p[2], direction: "read" },
            );
            this.delta(
              "host.disk.io",
              "By",
              "diskwrite:" + p[2],
              BigInt(p[9]) * 512n,
              { device: p[2], direction: "write" },
            );
          }
        } else {
          const d = await si.fsStats();
          if (signal?.aborted) return;
          this.delta(
            "host.disk.io",
            "By",
            "diskread:all",
            BigInt(Math.trunc(d.rx)),
            { device: "all", direction: "read" },
          );
          this.delta(
            "host.disk.io",
            "By",
            "diskwrite:all",
            BigInt(Math.trunc(d.wx)),
            { device: "all", direction: "write" },
          );
        }
      });
    if (selected.has("network"))
      await run("network", async () => {
        if (process.platform === "linux") {
          for (const line of readFileSync("/proc/net/dev", "utf8")
            .trim()
            .split("\n")
            .slice(2, 34)) {
            const [name, rest] = line.trim().split(":");
            if (!rest) continue;
            const p = rest.trim().split(/\s+/);
            this.delta(
              "host.network.io",
              "By",
              "netrecv:" + name,
              BigInt(p[0]),
              { interface: name, direction: "receive" },
            );
            this.delta(
              "host.network.io",
              "By",
              "netsend:" + name,
              BigInt(p[8]),
              { interface: name, direction: "transmit" },
            );
          }
        } else {
          for (const n of (await si.networkStats("*")).slice(0, 32)) {
            this.delta(
              "host.network.io",
              "By",
              "netrecv:" + n.iface,
              BigInt(Math.trunc(n.rx_bytes)),
              { interface: n.iface, direction: "receive" },
            );
            this.delta(
              "host.network.io",
              "By",
              "netsend:" + n.iface,
              BigInt(Math.trunc(n.tx_bytes)),
              { interface: n.iface, direction: "transmit" },
            );
          }
        }
      });
    if (selected.has("process"))
      await this.processes(tasks.process_names, signal);
    const stats = queueStats();
    for (const [name, key, unit] of [
      ["agent.queue.bytes", "queue_bytes", "By"],
      ["agent.queue.batches", "queue_batches", "1"],
      ["agent.queue.oldest_age", "oldest_age_seconds", "s"],
      ["agent.queue.quarantine", "quarantine_batches", "1"],
    ])
      this.gauge(name, unit, Number(stats[key]));
  }
  private async processes(patterns: string[], signal?: AbortSignal) {
    if (!patterns.length) return;
    const matchers = patterns.map((p) => ({ name: p, regex: glob(p) })),
      matched = new Map<string, number>(),
      active = new Set<string>();
    let failures = 0,
      unknown = 0;
    try {
      if (process.platform === "linux") {
        const hz = clockTicks(),
          btime = BigInt(
            /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1] ??
              "0",
          );
        for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
          if (signal?.aborted) return;
          let name: string;
          try {
            name = readFileSync(`/proc/${pid}/comm`, "utf8").trimEnd();
          } catch {
            unknown++;
            continue;
          }
          const p = matchers.find((x) => x.regex.test(name));
          if (!p || (matched.get(p.name) ?? 0) >= 8) continue;
          matched.set(p.name, (matched.get(p.name) ?? 0) + 1);
          try {
            const raw = readFileSync(`/proc/${pid}/stat`, "utf8"),
              s = raw.slice(raw.lastIndexOf(")") + 2).split(/\s+/),
              birth = btime * 1000n + (BigInt(s[19]) * 1000n) / hz,
              id = `${pid}:${birth}`,
              attr = { process_name: name, process_id: id, matcher: p.name };
            active.add("processcpu:" + id);
            this.gauge("process.running", "1", 1, attr);
            const status = readFileSync(`/proc/${pid}/status`, "utf8");
            this.gauge(
              "process.memory.rss",
              "By",
              Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) * 1024,
              attr,
            );
            this.gauge("process.threads", "1", Number(s[17]), attr);
            try {
              this.gauge(
                "process.file_descriptors",
                "1",
                readdirSync(`/proc/${pid}/fd`).length,
                attr,
              );
            } catch {}
            this.delta(
              "process.cpu.time",
              "ns",
              "processcpu:" + id,
              ((BigInt(s[11]) + BigInt(s[12])) * 1000000000n) / hz,
              attr,
            );
          } catch {
            failures++;
          }
        }
      } else {
        const ps = await si.processes();
        if (signal?.aborted) return;
        for (const proc of ps.list) {
          const p = matchers.find((x) => x.regex.test(proc.name));
          if (!p || (matched.get(p.name) ?? 0) >= 8) continue;
          matched.set(p.name, (matched.get(p.name) ?? 0) + 1);
          const id = `${proc.pid}:${Date.parse(proc.started) || 0}`,
            attr = { process_name: proc.name, process_id: id, matcher: p.name };
          active.add("processcpu:" + id);
          this.gauge("process.running", "1", 1, attr);
          this.gauge("process.memory.rss", "By", proc.memRss * 1024, attr);
          if (proc.pid === process.pid) {
            this.gauge(
              "process.file_descriptors",
              "1",
              Number((process as any)._getActiveHandles?.().length ?? 0),
              attr,
            );
            const cpu = process.cpuUsage();
            this.delta(
              "process.cpu.time",
              "ns",
              "processcpu:" + id,
              BigInt(cpu.user + cpu.system) * 1000n,
              attr,
            );
          }
        }
      }
      for (const key of this.previous.keys())
        if (key.startsWith("processcpu:") && !active.has(key))
          this.previous.delete(key);
      for (const p of patterns)
        if ((matched.get(p) ?? 0) > 0 || unknown === 0)
          this.gauge(
            "process.matcher.running",
            "1",
            (matched.get(p) ?? 0) > 0 ? 1 : 0,
            { matcher: p },
          );
      this.status(
        "process",
        failures || unknown
          ? `partial: ${failures} unavailable measurements, ${unknown} unreadable process names`
          : "ok",
      );
    } catch (e) {
      this.status("process", (e as Error).message);
    }
  }
}
let ticks: bigint | undefined;
function clockTicks(): bigint {
  if (!ticks) {
    const value = execFileSync("getconf", ["CLK_TCK"], {
      encoding: "utf8",
      timeout: 1000,
    }).trim();
    ticks = BigInt(value);
    if (ticks <= 0n) throw Error("invalid host clock tick rate");
  }
  return ticks;
}
