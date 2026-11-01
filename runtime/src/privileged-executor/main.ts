import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Validate real OS identity and every executable module before importing the
// composition root. No Agent-owned config/plugin/module is loaded by root.
function trusted(path: string): void {
  let at = path;
  for (;;) { const s = lstatSync(at); if (s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022)) throw Error("unsafe_executor_program"); if (at === "/") break; at = dirname(at); }
}
function tree(path: string): void {
  trusted(path);
  const s = lstatSync(path);
  if (s.isDirectory()) for (const name of readdirSync(path)) tree(join(path, name));
  else if (!s.isFile()) throw Error("unsafe_executor_program");
}
async function main(): Promise<void> {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.geteuid?.() !== 0) throw Error("executor_requires_linux_root");
  trusted(realpathSync(process.execPath));
  const directory = dirname(fileURLToPath(import.meta.url)); tree(directory); tree(join(dirname(directory), "shared"));
  const { execute } = await import("./cli.js"); await execute(process.argv.slice(2));
}
main().catch(error => { const code = error instanceof Error && /^[a-z0-9_]{1,64}$/.test(error.message) ? error.message : "executor_refused"; process.stderr.write(code + "\n"); process.exitCode = 1; });
