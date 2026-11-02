import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function assertTrustedAgentMetadata(info: {
  uid: number;
  mode: number;
}): void {
  if (info.uid !== 0 || (info.mode & 0o022) !== 0)
    throw Error("unsafe_root_agent_program");
}
/** Only builtins load before validating every module and dependency as root. */
export function assertTrustedAgentTree(
  appDirectory: string,
  executable = process.execPath,
): void {
  const ancestry = (filename: string) => {
    let at = filename;
    for (;;) {
      const s = lstatSync(at);
      if (s.isSymbolicLink()) throw Error("unsafe_root_agent_program");
      assertTrustedAgentMetadata(s);
      if (at === dirname(at)) break;
      at = dirname(at);
    }
  };
  ancestry(realpathSync(executable));
  ancestry(appDirectory);
  const visited = new Set<string>();
  const walk = (filename: string) => {
    const info = lstatSync(filename);
    if (info.isSymbolicLink()) {
      if (info.uid !== 0) throw Error("unsafe_root_agent_program");
      const target = realpathSync(filename),
        part = relative(appDirectory, target);
      if (part.startsWith("..") || isAbsolute(part))
        throw Error("unsafe_root_agent_program");
      walk(target);
      return;
    }
    assertTrustedAgentMetadata(info);
    if (!info.isFile() && !info.isDirectory())
      throw Error("unsafe_root_agent_program");
    if (visited.has(filename)) return;
    visited.add(filename);
    if (info.isDirectory())
      for (const name of readdirSync(filename)) walk(join(filename, name));
  };
  walk(appDirectory);
}
export function requiresTrustedAgentStartup(args: readonly string[]): boolean {
  const command = args[0] && !args[0].startsWith("-") ? args[0] : "run";
  return (
    command === "run" ||
    command === "status" ||
    command === "quarantine" ||
    command.startsWith("managed-")
  );
}
async function main() {
  // Offline configure/check run only within an installer-verified release. They
  // do not initialize task runners and may be invoked from its staging path.
  if (
    requiresTrustedAgentStartup(process.argv.slice(2)) &&
    (process.getuid?.() === 0 || process.geteuid?.() === 0)
  ) {
    if (
      process.platform !== "linux" ||
      process.getuid?.() !== 0 ||
      process.geteuid?.() !== 0
    )
      throw Error("root_agent_requires_linux_root");
    assertTrustedAgentTree(
      fileURLToPath(new URL("../../../", import.meta.url)),
    );
  }
  const { execute } = await import("./main.js");
  await execute(process.argv.slice(2));
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
)
  main().catch((error) => {
    process.stderr.write(
      (error instanceof Error && /^[a-z0-9_]{1,96}$/.test(error.message)
        ? error.message
        : "agent_start_refused") + "\n",
    );
    process.exitCode = 1;
  });
