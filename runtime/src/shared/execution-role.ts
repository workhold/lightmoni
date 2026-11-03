/** Role flags never grant OS privileges. Offline installer commands are separate. */
export function assertOrdinaryAgentIdentity(uid: number | undefined, euid: number | undefined): void {
  if (uid === 0 || euid === 0) throw Error("ordinary_agent_requires_non_root: use the lightmoni-agent service account; privileged tasks require the separate executor");
}

export interface AgentRuntimeIdentity { mode: "root" | "user"; permission_generation: number; uid: number; gid: number }
/** The runtime mode selects a root-owned helper, never a root Agent daemon. */
export function assertAgentRuntimeIdentity(mode: "root" | "user", generation: number, uid: number | undefined, euid: number | undefined, gid: number | undefined, platform = process.platform): AgentRuntimeIdentity {
  if (!["root", "user"].includes(mode) || !Number.isSafeInteger(generation) || generation < 1) throw Error("invalid_agent_runtime");
  if (platform === "linux") assertOrdinaryAgentIdentity(uid, euid);
  else if (uid === 0 || euid === 0) throw Error("ordinary_agent_requires_non_root");
  if (!Number.isSafeInteger(gid) || gid === 0 || gid === undefined) throw Error("ordinary_agent_requires_non_root");
  return { mode, permission_generation: generation, uid: uid ?? -1, gid: gid ?? -1 };
}
