import { spawn, execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizePrivilegedPayload, validatePrivilegedPayload, type ScriptPayload } from "../shared/privileged-executor.js";
import { boundedFile, refuse, rootPath, sha256, type BootClock, linuxBootClock } from "./security.js";

export type ElevatedScript = ScriptPayload;
export interface AccountProfile { name: string; uid: number; gid: number; groups: number[] }
export interface ScriptOutcome { state: "succeeded" | "failed" | "unknown"; code: string; summary: string; exit_code: number | null; stdout: string; stderr: string }
export interface ExecutionStartGuard { assert(): void; snapshot(): {boot_id: string; expires_uptime_ms: number} }
export interface ScriptHost {
  interpreter(runtime: "shell" | "node"): string;
  account(name: string): AccountProfile;
  run(unit: string, interpreter: string, payload: ElevatedScript, signal: AbortSignal, guard?: ExecutionStartGuard): Promise<ScriptOutcome>;
}
export function validateScript(value: unknown): ElevatedScript {
  validatePrivilegedPayload(value);
  const payload = normalizePrivilegedPayload(value);
  if (payload.kind !== "script") return refuse("unsafe_script_spec");
  // Additional inherited-runtime variables are forbidden locally even if a
  // future server accidentally expands its environment allowlist.
  if (Object.keys(payload.environment).some(key => /^(?:IFS|SHELLOPTS|USER|LOGNAME|SSH_.*|SUDO_.*|SYSTEMD_.*|GCONV_.*|LOCPATH|GLIBC_TUNABLES)$/.test(key))) refuse("unsafe_environment");
  return payload;
}
export function sameAccount(left: AccountProfile, right: AccountProfile): boolean {
  return left.name === right.name && left.uid === right.uid && left.gid === right.gid
    && JSON.stringify([...left.groups].sort((a,b) => a-b)) === JSON.stringify([...right.groups].sort((a,b) => a-b));
}
export function localAccount(name: string): AccountProfile {
  if (!/^[a-z_][a-z0-9_-]{0,31}\$?$/.test(name)) refuse("unsafe_account");
  rootPath("/usr/bin/id");
  const run = (option: string) => execFileSync("/usr/bin/id", [option, name], { encoding: "utf8", timeout: 5000, env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdio: ["ignore", "pipe", "ignore"] }).trim();
  const uid = Number(run("-u")), gid = Number(run("-g")), groups = run("-G").split(/\s+/).map(Number).filter(number => number !== gid);
  if (![uid, gid, ...groups].every(Number.isSafeInteger)) refuse("account_changed");
  return { name, uid, gid, groups: [...new Set(groups)].sort((a,b) => a-b) };
}
export function interpreterPath(runtime: "shell" | "node"): string {
  const filename = realpathSync(runtime === "shell" ? "/bin/sh" : process.execPath);
  rootPath(filename); return filename;
}
export function interpreterDigest(filename: string): string { return sha256(boundedFile(filename, 128 << 20)); }
export function scriptDependenciesReady(): boolean {
  try {
    rootPath("/usr/bin/systemd-run"); rootPath("/usr/bin/systemctl"); rootPath("/usr/bin/busctl"); rootPath("/run/systemd/system", "directory"); rootPath("/run/dbus", "directory");
    rootPath(fileURLToPath(new URL("./script-launcher.js", import.meta.url)));
    const version = execFileSync("/usr/bin/systemctl", ["show", "--property=Version", "--value"], { encoding: "utf8", timeout: 2000, maxBuffer: 1024, env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!/^[0-9]{3,4}(?:[.-][A-Za-z0-9.+~_-]+)?$/.test(version)) return false;
    // systemctl can use /run/systemd/private even when the system bus required
    // by systemd-run is missing. Probe that exact bus before advertising ready.
    execFileSync("/usr/bin/busctl", ["--system", "status", "org.freedesktop.systemd1"], { timeout: 2000, maxBuffer: 32768, env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch { return false; }
}

export async function executeScript(payload: unknown, unit: string, accounts: readonly AccountProfile[], host: ScriptHost, signal: AbortSignal, guard?: ExecutionStartGuard): Promise<ScriptOutcome> {
  const script = validateScript(payload);
  if (!/^lightmoni-exec-[a-f0-9]{32}$/.test(unit)) refuse("invalid_unit");
  const allowed = accounts.find(account => sameAccount(account, script.account));
  if (!allowed || !sameAccount(host.account(script.account.name), script.account)) refuse("account_changed");
  if (signal.aborted) refuse("execution_cancelled");
  return host.run(unit, host.interpreter(script.runtime), script, signal, guard);
}

export interface UnitObservation { LoadState: string; ActiveState: string; SubState: string; Result: string; ExecMainCode: string; ExecMainStatus: string; InvocationID: string }
export function unitOutcome(observation: UnitObservation, reason = ""): Omit<ScriptOutcome, "stdout" | "stderr"> {
  const o = observation;
  const consistent = o.ActiveState === "active" && o.SubState === "exited" || o.ActiveState === "failed" && o.SubState === "failed" || o.ActiveState === "inactive" && o.SubState === "dead";
  if (o.LoadState !== "loaded" || !/^[a-f0-9]{32}$/.test(o.InvocationID) || !consistent
    || !["success", "exit-code", "signal", "core-dump", "timeout", "watchdog", "start-limit-hit", "resources", "protocol", "oom-kill"].includes(o.Result)
    || !["1", "2", "3"].includes(o.ExecMainCode) || !/^\d{1,3}$/.test(o.ExecMainStatus)
    || o.Result === "success" && (o.ActiveState === "failed" || o.ExecMainCode !== "1" || o.ExecMainStatus !== "0"))
    return { state: "unknown", code: "execution_unknown", summary: "Service outcome requires read-only reconciliation", exit_code: null };
  const status = Number(o.ExecMainStatus);
  if (status > 255) return { state: "unknown", code: "execution_unknown", summary: "Service outcome requires read-only reconciliation", exit_code: null };
  const succeeded = o.Result === "success" && o.ExecMainCode === "1" && status === 0 && !reason;
  return { state: succeeded ? "succeeded" : "failed", code: reason || (succeeded ? "script_succeeded" : "script_failed"), summary: succeeded ? "Approved script completed" : "Approved script did not complete successfully", exit_code: o.ExecMainCode === "1" ? status : null };
}
export function observeUnit(unit: string): UnitObservation {
  if (!/^lightmoni-exec-[a-f0-9]{32}$/.test(unit)) refuse("invalid_unit");
  rootPath("/usr/bin/systemctl");
  const keys = ["LoadState", "ActiveState", "SubState", "Result", "ExecMainCode", "ExecMainStatus", "InvocationID"];
  const raw = execFileSync("/usr/bin/systemctl", ["show", unit + ".service", ...keys.map(key => "--property=" + key)], { encoding: "utf8", timeout: 5000, maxBuffer: 16384, env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdio: ["ignore", "pipe", "ignore"] });
  const values: Record<string,string> = {};
  for (const line of raw.trim().split("\n")) { const split = line.indexOf("="); const key = line.slice(0, split); if (split > 0 && keys.includes(key) && !Object.hasOwn(values, key)) values[key] = line.slice(split + 1); else refuse("invalid_unit_observation"); }
  if (keys.some(key => !Object.hasOwn(values, key))) refuse("invalid_unit_observation");
  return values as unknown as UnitObservation;
}

/** Root starts a trusted launcher over stdin. The launcher sets exact supplementary
 * groups/GID/UID before running the approved interpreter. No code or environment
 * secret enters argv, an EnvironmentFile, or the executor's inherited FDs. */
export function productionScriptHost(clock: BootClock = linuxBootClock): ScriptHost {
  return {
    interpreter: interpreterPath, account: localAccount,
    async run(unit, interpreter, payload, signal, guard) {
      if (signal.aborted) refuse("execution_cancelled");
      const requiredGuard = guard ?? refuse("start_permit_required");
      rootPath("/usr/bin/systemd-run"); rootPath("/usr/bin/systemctl");
      const node = interpreterPath("node"), launcher = fileURLToPath(new URL("./script-launcher.js", import.meta.url)); rootPath(launcher);
      if (interpreterDigest(interpreter) !== payload.interpreter_sha256 || !sameAccount(localAccount(payload.account.name), payload.account)) refuse("account_changed");
      const args = ["--quiet", "--wait", "--pipe", "--service-type=exec", "--unit=" + unit,
        "--property=User=0", "--property=Group=0", "--property=SupplementaryGroups=", "--property=UMask=0077",
        "--property=RuntimeDirectory=" + unit, "--property=RuntimeDirectoryMode=0700", "--property=WorkingDirectory=/run/" + unit,
        "--property=KillMode=control-group", "--property=TimeoutStopSec=10s", "--property=RuntimeMaxSec=" + Math.ceil(payload.timeout_ms / 1000),
        "--property=RemainAfterExit=yes", "--property=NoNewPrivileges=yes", "--property=LimitCORE=0", "--property=TasksMax=256",
        "--", node, launcher, unit];
      const began = clock.now(), boot = clock.bootID();
      requiredGuard.assert(); const startDeadline = requiredGuard.snapshot();
      return await new Promise<ScriptOutcome>((resolve) => {
        requiredGuard.assert();
        const child = spawn("/usr/bin/systemd-run", args, { env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdio: ["pipe", "pipe", "pipe"] });
        const stdout: Buffer[] = [], stderr: Buffer[] = []; let bytes = 0, stopping = false, reason = "", uncertain = false, settled = false;
        let terminalProof: UnitObservation | undefined;
        let fallback: ReturnType<typeof setTimeout> | undefined;
        const finish = (failedTransport = false) => {
          if (settled) return; settled = true; clearInterval(timer); if (fallback) clearTimeout(fallback); signal.removeEventListener("abort", abort);
          let result: Omit<ScriptOutcome, "stdout" | "stderr"> = { state: "unknown", code: "execution_unknown", summary: "Service outcome requires read-only reconciliation", exit_code: null };
          if (!failedTransport && !uncertain) { try { result = unitOutcome(terminalProof ?? observeUnit(unit), reason); } catch {} }
          // An unknown service may retain its duplicated pipe FDs. Detach only
          // this client's streams so uncertainty does not leak handles or keep
          // a stopping executor alive; the durable fence remains in force.
          if (failedTransport || uncertain) { child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); child.kill("SIGKILL"); }
          resolve({ ...result, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
        };
        const stop = (code: string) => {
          if (stopping) return; stopping = true; reason = code;
          try { execFileSync("/usr/bin/systemctl", ["kill", "--kill-whom=all", "--signal=SIGKILL", unit + ".service"], { timeout: 5000, env: { PATH: "/usr/bin:/bin" }, stdio: "ignore" }); }
          catch { uncertain = true; }
          child.kill("SIGTERM"); fallback = setTimeout(() => { child.kill("SIGKILL"); finish(true); }, 6000); fallback.unref();
        };
        const collect = (target: Buffer[], chunk: Buffer) => {
          const remaining = Math.max(0, payload.max_output_bytes - bytes);
          if (remaining) target.push(chunk.subarray(0, remaining));
          bytes += chunk.length; if (bytes > payload.max_output_bytes) stop("output_limit");
        };
        const abort = () => stop("cancel_requested");
        let lastObservation = began;
        const timer = setInterval(() => {
          try {
            const now = clock.now();
            if (clock.bootID() !== boot || !Number.isFinite(now) || now < lastObservation || now - began >= payload.timeout_ms) { stop("timeout"); return; }
            // RemainAfterExit keeps the immutable unit result available. The
            // --wait client can remain attached to that active(exited) unit;
            // close only the client after observing the service has exited.
            if (now - lastObservation >= 750) {
              lastObservation = now;
              try {
                const observation = observeUnit(unit);
                // RemainAfterExit keeps systemd's copies of the IO FDs open
                // even after the launcher exited. Freeze that exact invocation
                // result, then stop the completed unit to release those FDs and
                // any remaining descendants before acknowledging completion.
                if (unitOutcome(observation).state !== "unknown" && !terminalProof) {
                  execFileSync("/usr/bin/systemctl", ["stop", unit + ".service"], { timeout: 5000, env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdio: "ignore" });
                  terminalProof = observation;
                  child.kill("SIGKILL");
                }
              } catch {}
            }
          } catch { stop("unreliable_clock"); }
        }, 250);
        timer.unref();
        child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk)); child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
        child.stdin.on("error", () => { uncertain = true; stop("stdin_failed"); }); child.stdin.end(JSON.stringify({ payload, interpreter, start_deadline: startDeadline }));
        signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) stop("cancel_requested");
        child.once("error", () => finish(true)); child.once("close", () => finish());
      });
    },
  };
}
