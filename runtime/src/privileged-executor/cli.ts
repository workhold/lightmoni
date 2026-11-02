import { existsSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStrictJSON } from "../shared/privileged-executor.js";
import { EXECUTOR_CONFIG, loadConfig, newConfig, parseBootstrap, saveInitialConfig } from "./config.js";
import { ExecutorJournal } from "./journal.js";
import { ExecutorClient } from "./client.js";
import { inspectManagedDockerDaemon } from "./docker.js";
import { PrivilegedExecutorRunner } from "./runner.js";
import { readExecutorRelease } from "./release.js";
import { executorStatus } from "./status.js";
import { readExecutorActivation } from "./activation.js";
import { assertRoot, refuse, rootPath } from "./security.js";

export interface ExecutorCLIIO { input: AsyncIterable<Uint8Array | string>; write(value: string): void; signal?: AbortSignal }
export async function execute(args: string[], io: ExecutorCLIIO = { input: process.stdin, write: v => { process.stdout.write(v); } }): Promise<void> {
  assertRoot(); process.umask(0o077);
  const command = args[0] ?? "run";
  if (!["enroll", "run", "check", "status", "worker"].includes(command)) refuse("unknown_executor_command");
  let filename = EXECUTOR_CONFIG;
  if (args.length > 1) { if (args.length !== 3 || args[1] !== "--config" || !args[2]) refuse("invalid_executor_arguments"); filename = args[2]; }
  const release = readExecutorRelease();
  if (command === "enroll") {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const value of io.input) { const chunk = Buffer.from(value); bytes += chunk.length; if (bytes > 64 << 10) refuse("bootstrap_too_large"); chunks.push(chunk); }
    const bootstrap = parseBootstrap(parseStrictJSON(Buffer.concat(chunks), 64 << 10));
    let daemonID = ""; try { daemonID = (await inspectManagedDockerDaemon()).daemon_id; } catch { /* unavailable is reported; never change the identity during run */ }
    const config = newConfig(bootstrap, daemonID); saveInitialConfig(filename, config);
    const activation_id=readExecutorActivation(config,release,true);
    const journal = new ExecutorJournal(config.data_dir, Buffer.from(config.output_key, "hex"));
    try {
      const client = new ExecutorClient(config, journal); await client.enroll(bootstrap);
      const runner = new PrivilegedExecutorRunner(config, journal, client, { ...release,activation_id }); await runner.heartbeat();
      io.write(JSON.stringify({ executor_id: config.executor_id, machine_id: config.machine_id, install_generation: config.install_generation, enrolled: true }) + "\n");
    } finally { journal.close(); }
    return;
  }
  const config = loadConfig(filename);
  if (command === "check" || command === "status") {
    const status = executorStatus(config);
    if (command === "check") io.write("executor configuration valid\n"); else io.write(JSON.stringify(status) + "\n");
    return;
  }
  if (command === "run") {
    // The kernel-owned flock outlives this CLI through the child. A stale PID
    // file cannot safely serialize two recovering processes, so never use one.
    rootPath("/usr/bin/flock"); const node = rootPath(realpathSync(process.execPath));
    const lock = join(config.data_dir, "writer.lock"); if (existsSync(lock)) rootPath(lock, "file", true);
    const main = rootPath(fileURLToPath(new URL("./main.js", import.meta.url)));
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/flock", ["--exclusive", "--nonblock", lock, node, main, "worker", "--config", filename], { env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: "inherit" });
      const abort = () => { child.kill("SIGTERM"); }; io.signal?.addEventListener("abort", abort, { once: true });
      child.once("error", reject); child.once("exit", (code) => { io.signal?.removeEventListener("abort", abort); if (code === 0 || io.signal?.aborted) resolve(); else reject(Error("executor_worker_stopped")); });
    });
    return;
  }
  // worker is an internal, Linux-root-only entry invoked by the flock wrapper.
  // It has the same root/private-policy checks and no identity bypass switches.
  const activation_id=readExecutorActivation(config,release);
  const journal = new ExecutorJournal(config.data_dir, Buffer.from(config.output_key, "hex"));
  const client = new ExecutorClient(config, journal), runner = new PrivilegedExecutorRunner(config, journal, client, { ...release,activation_id });
  const controller = new AbortController(), stop = () => controller.abort();
  process.once("SIGTERM", stop); process.once("SIGINT", stop); io.signal?.addEventListener("abort", stop, { once: true });
  try {
    while (!controller.signal.aborted) {
      try { await runner.once(controller.signal); }
      catch (error) { const code = error instanceof Error && /^[a-z0-9_]{1,64}$/.test(error.message) ? error.message : "executor_cycle_refused"; io.write(code + "\n"); }
      if (!controller.signal.aborted) await new Promise<void>(resolve => { const timer = setTimeout(done, 5000); const abort = () => done(); function done() { clearTimeout(timer); controller.signal.removeEventListener("abort", abort); resolve(); } controller.signal.addEventListener("abort", abort, { once: true }); });
    }
  } finally { process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); io.signal?.removeEventListener("abort", stop); runner.close(); journal.close(); }
}
