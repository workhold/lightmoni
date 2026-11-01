/** Role flags never grant OS privileges. Offline installer commands are separate. */
export function assertOrdinaryAgentIdentity(uid: number | undefined, euid: number | undefined): void {
  if (uid === 0 || euid === 0) throw Error("ordinary_agent_requires_non_root: use the lightmoni-agent service account; privileged tasks require the separate executor");
}
