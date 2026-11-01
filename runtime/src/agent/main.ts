import { existsSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { defaultConfig, loadConfig, saveConfig } from "./config.js";
import { readAgentRelease } from "./release.js";
import { createAgent } from "./agent.js";
import { Queue } from "./queue.js";
import { responseBytes } from "./util.js";
import { assertOrdinaryAgentIdentity } from "../shared/execution-role.js";
export { createAgent } from "./agent.js";
export interface CLIIO {
  input: AsyncIterable<Uint8Array | string>;
  write: (text: string) => void;
  signal?: AbortSignal;
}
export async function execute(
  args: string[],
  io: CLIIO = {
    input: process.stdin,
    write: (text) => process.stdout.write(text),
  },
): Promise<void> {
  const remaining = [...args];
  const command =
    remaining.length && !remaining[0].startsWith("-")
      ? remaining.shift()!
      : "run";
  const flags: Record<string, string | boolean> = {
    config: "/etc/lightmoni-agent/config.json",
    action: "list",
    id: "",
    "confirm-data-loss": false,
    "require-data-dir": "",
    endpoint: "",
    "group-id": "",
    "pending-enrollment": false,
  };
  const seenFlags = new Set<string>();
  for (let i = 0; i < remaining.length; i++) {
    const raw = remaining[i];
    if (!raw.startsWith("-")) throw Error("unexpected argument " + raw);
    const [key, ...value] = raw.replace(/^--?/, "").split("=");
    if (!Object.hasOwn(flags, key)) throw Error("unknown flag " + key);
    seenFlags.add(key);
    if (typeof flags[key] === "boolean") {
      if (value.length && !["true", "false"].includes(value.join("=")))
        throw Error("invalid boolean flag");
      flags[key] = value.length ? value.join("=") === "true" : true;
    } else {
      const text = value.length ? value.join("=") : remaining[++i];
      if (text === undefined) throw Error("flag requires a value: " + key);
      flags[key] = text;
    }
  }
  if (seenFlags.has("pending-enrollment") && !["configure", "check"].includes(command))
    throw Error("--pending-enrollment is only allowed for configure and check");
  if (command === "version") {
    io.write(readAgentRelease().version + "\n");
    return;
  }
  // Check before reading runtime credentials or initializing any task runner.
  if (command === "run") assertOrdinaryAgentIdentity(process.getuid?.(), process.geteuid?.());
  const validation = { pendingEnrollment: Boolean(flags["pending-enrollment"]) };
  const path = String(flags.config),
    requireDir = String(flags["require-data-dir"]);
  if (command === "configure") {
    const config = existsSync(path) ? loadConfig(path, validation) : defaultConfig();
    if (flags.endpoint) config.endpoint = String(flags.endpoint);
    if (flags["group-id"]) config.group_id = String(flags["group-id"]);
    if (requireDir) config.data_dir = requireDir;
    saveConfig(path, config, validation);
    io.write("reporting configuration saved\n");
    return;
  }
  const config = loadConfig(path, validation);
  if (command === "check") {
    if (requireDir && config.data_dir !== requireDir)
      throw Error("this system service requires data_dir=" + requireDir);
    io.write("configuration valid\n");
    return;
  }
  if (command === "status") {
    const response = await fetch("http://" + config.listen + "/status", {
      headers: config.local_token
        ? { Authorization: "Bearer " + config.local_token }
        : {},
      signal: AbortSignal.timeout(5000),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw Error("status HTTP " + response.status);
    }
    io.write((await responseBytes(response, 4 << 20)).toString("utf8"));
    return;
  }
  if (command === "quarantine") {
    const queue = new Queue(config);
    try {
      const action = String(flags.action);
      if (action === "list")
        io.write(JSON.stringify(queue.quarantined()) + "\n");
      else if (action === "retry") {
        if (!flags.id) throw Error("id required");
        queue.resolve(String(flags.id), false);
      } else if (action === "discard") {
        if (!flags.id || !flags["confirm-data-loss"])
          throw Error("discard requires --id and --confirm-data-loss");
        queue.resolve(String(flags.id), true);
      } else throw Error("unknown quarantine action");
    } finally {
      queue.close();
    }
    return;
  }
  if (command === "run") {
    const agent = createAgent(config),
      controller = new AbortController(),
      stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await agent.run(
        io.signal
          ? AbortSignal.any([io.signal, controller.signal])
          : controller.signal,
      );
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      await agent.close();
    }
    return;
  }
  throw Error(
    `unknown command ${JSON.stringify(command)}; use run, configure, check, status, quarantine or version`,
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
)
  execute(process.argv.slice(2)).catch((error) => {
    process.stderr.write("agent stopped: " + (error as Error).message + "\n");
    process.exitCode = 1;
  });
