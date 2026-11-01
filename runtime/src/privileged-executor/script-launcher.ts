import { spawn } from "node:child_process";
import { chownSync, lstatSync } from "node:fs";
import { assertRoot, refuse, linuxBootClock } from "./security.js";
import { parseStrictJSON, strictRecord } from "../shared/privileged-executor.js";
import { validateScript, interpreterPath, interpreterDigest, localAccount, sameAccount } from "./scripts.js";

/** Fixed root-owned helper, invoked only inside the per-run transient unit.
 * It accepts a bounded snapshot through stdin and never loads Agent state. */
async function launch(): Promise<void> {
  assertRoot();
  const unit = process.argv[2]; if (process.argv.length !== 3 || !/^lightmoni-exec-[a-f0-9]{32}$/.test(unit)) refuse("invalid_unit");
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const value of process.stdin) { const chunk = Buffer.from(value); bytes += chunk.length; if (bytes > 1 << 20) refuse("input_limit"); chunks.push(chunk); }
  const input = strictRecord(parseStrictJSON(Buffer.concat(chunks)), ["payload", "interpreter", "start_deadline"]), payload = validateScript(input.payload);
  const deadline = strictRecord(input.start_deadline, ["boot_id", "expires_uptime_ms"]);
  const assertStart = () => { const now = linuxBootClock.now(); if (deadline.boot_id !== linuxBootClock.bootID() || !Number.isFinite(deadline.expires_uptime_ms) || deadline.expires_uptime_ms <= now || deadline.expires_uptime_ms > now + 30_000) refuse("expired_permit"); };
  assertStart();
  const interpreter = interpreterPath(payload.runtime);
  if (interpreter !== input.interpreter || interpreterDigest(interpreter) !== payload.interpreter_sha256 || !sameAccount(localAccount(payload.account.name), payload.account)) refuse("account_changed");
  const work = "/run/" + unit, info = lstatSync(work);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o077) !== 0 || process.cwd() !== work) refuse("unsafe_work_directory");
  chownSync(work, payload.account.uid, payload.account.gid);
  // Explicit setgroups avoids systemd/NSS silently supplementing the approved
  // group snapshot. UID/GID changes are irreversible for non-root targets.
  process.setgroups!(payload.account.groups); process.setgid!(payload.account.gid); process.setuid!(payload.account.uid);
  if (process.getuid!() !== payload.account.uid || process.getgid!() !== payload.account.gid || JSON.stringify(process.getgroups!().filter(g => g !== payload.account.gid).sort((a,b)=>a-b)) !== JSON.stringify([...payload.account.groups].sort((a,b)=>a-b))) refuse("account_changed");
  assertStart();
  const child = spawn(interpreter, [...(payload.runtime === "shell" ? ["-s", "--"] : ["--input-type=commonjs", "-"]), ...payload.args], {
    cwd: work, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: work, ...payload.environment }, stdio: ["pipe", "inherit", "inherit"],
  });
  child.stdin.on("error", () => { child.kill("SIGKILL"); }); child.stdin.end(payload.code);
  child.on("error", () => { process.exitCode = 125; });
  child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 128 : 125); });
}
launch().catch(() => { process.stderr.write("approved_script_launch_failed\n"); process.exitCode = 125; });
