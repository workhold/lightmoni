import * as fs from "node:fs";
import { execFileSync } from "node:child_process";

export const ORDINARY_AGENT_BLOCKED_GROUPS = new Set(["root", "docker", "lxd", "lxc", "incus-admin", "libvirt", "disk", "kmem", "sudo", "wheel"]);
export interface OrdinaryAgentPermissionSnapshot {
  uid: number; euid: number; gid: number; groups: number[]; names: string[];
  capabilities: { inheritable: string; permitted: string; effective: string; ambient: string };
}
export function assertOrdinaryAgentPermissions(snapshot: OrdinaryAgentPermissionSnapshot): void {
  if (!Array.isArray(snapshot.groups) || !Array.isArray(snapshot.names) || !snapshot.capabilities
    || Object.keys(snapshot.capabilities).sort().join(",") !== "ambient,effective,inheritable,permitted") throw Error("agent_permission_observation_failed");
  const values = [snapshot.uid, snapshot.euid, snapshot.gid, ...snapshot.groups];
  if (values.some(v => !Number.isSafeInteger(v) || v < 0) || snapshot.uid === 0 || snapshot.euid === 0 || snapshot.gid === 0 || snapshot.groups.includes(0)) throw Error("agent_privilege_migration_required");
  if (!snapshot.names.length || snapshot.names.some(name => !/^[A-Za-z_][A-Za-z0-9_.-]*\$?$/.test(name))) throw Error("agent_permission_observation_failed");
  if (snapshot.names.some(name => ORDINARY_AGENT_BLOCKED_GROUPS.has(name))) throw Error("agent_privilege_migration_required");
  for (const value of Object.values(snapshot.capabilities)) {
    if (typeof value !== "string" || !/^[a-fA-F0-9]{1,32}$/.test(value)) throw Error("agent_permission_observation_failed");
    if (BigInt("0x" + value) !== 0n) throw Error("agent_privilege_migration_required");
  }
}

/** Startup observation is Linux-specific. It never removes administrator-owned
 * groups, ACLs, capabilities, socket modes or legacy unit settings. */
export function observeOrdinaryAgentPermissions(): OrdinaryAgentPermissionSnapshot {
  if (process.platform !== "linux") throw Error("linux_permission_observation_required");
  const status = fs.readFileSync("/proc/self/status", "utf8");
  const capability = (name: string) => {
    const matches = [...status.matchAll(new RegExp("^" + name + ":[ \\t]+([a-fA-F0-9]+)$", "gm"))];
    if (matches.length !== 1) throw Error("agent_permission_observation_failed");
    return matches[0][1];
  };
  const names = execFileSync("/usr/bin/id", ["-Gn"], { encoding: "utf8", timeout: 5000, maxBuffer: 8192, env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\s+/);
  return { uid: process.getuid!(), euid: process.geteuid!(), gid: process.getgid!(), groups: process.getgroups!(), names,
    capabilities: { inheritable: capability("CapInh"), permitted: capability("CapPrm"), effective: capability("CapEff"), ambient: capability("CapAmb") } };
}
export function assertOrdinaryAgentSocketIsolation(socket = "/var/run/docker.sock"): void {
  // Only the standard local Docker socket is observed. Alternate externally
  // configured endpoints and arbitrary external root powers are not claimed
  // to be a general-purpose sandbox.
  let info: fs.Stats;
  try { info = fs.lstatSync(socket); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw Error("agent_permission_observation_failed"); }
  if (info.isSymbolicLink() || !info.isSocket()) throw Error("agent_privilege_migration_required");
  try { fs.accessSync(socket, fs.constants.W_OK); }
  catch (error) {
    if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw Error("agent_permission_observation_failed");
  }
  throw Error("agent_privilege_migration_required");
}
export function assertOrdinaryAgentLinuxPermissions(): void {
  if (process.platform !== "linux") return;
  assertOrdinaryAgentPermissions(observeOrdinaryAgentPermissions()); assertOrdinaryAgentSocketIsolation();
}
