import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Rewrite fixed Linux roots in one pass, including the shared guard's ancestors. */
export const rewriteMaintenancePaths = (script: string, root: string) =>
  script.replace(/\/(run|etc|usr|opt|var)(?=[^A-Za-z0-9_.-]|$)/g, value => join(root, value.slice(1)));

/** Synthetic ownership for unprivileged macOS fixtures; permissions stay real.
 * This checks decisions, not Linux root ownership or actual systemd behaviour. */
export function writeMaintenanceStatShim(directory: string) {
  writeFileSync(join(directory, "stat"), `#!${process.execPath}
const fs=require('node:fs'),p=process.argv.at(-1),info=fs.lstatSync(p);
console.log((p===process.env.TEST_NON_ROOT_PATH?'123':'0')+':'+(info.mode&0o7777).toString(8));
`, { mode: 0o755 });
}
