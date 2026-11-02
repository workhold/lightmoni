/** Role flags never grant OS privileges. Offline installer commands are separate. */
export function assertOrdinaryAgentIdentity(uid: number | undefined, euid: number | undefined): void {
  if (uid === 0 || euid === 0) throw Error("ordinary_agent_requires_non_root: use the lightmoni-agent service account; privileged tasks require the separate executor");
}

export interface AgentRuntimeIdentity { mode: "root" | "user"; permission_generation: number; uid: number; gid: number }
/** Configuration verifies an OS identity; it never grants privileges. */
export function assertAgentRuntimeIdentity(mode: "root" | "user", generation: number, uid: number | undefined, euid: number | undefined, gid: number | undefined, platform = process.platform): AgentRuntimeIdentity {
  if (!["root", "user"].includes(mode) || !Number.isSafeInteger(generation) || generation < 1) throw Error("invalid_agent_runtime");
  if (mode === "root") {
    if (platform !== "linux" || uid !== 0 || euid !== 0 || gid !== 0) throw Error("root_agent_requires_linux_root");
  } else assertOrdinaryAgentIdentity(uid, euid);
  return { mode, permission_generation: generation, uid: uid ?? -1, gid: gid ?? -1 };
}
