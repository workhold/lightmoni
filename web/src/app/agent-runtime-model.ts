export type AgentRuntimeMode = "root" | "user";
export type AgentRuntimeObservation = {
  mode: AgentRuntimeMode;
  permission_generation: number;
  uid: number;
  gid: number;
};
export type AgentRuntimePlan = {
  id: string;
  status: string;
  revision: string;
  expires_at: string;
  created_at?: string;
  started_at?: string;
  finished_at?: string;
  error?: string;
  plan: {
    machine: {
      id: string;
      name: string;
      agent_id: string;
      address?: string;
    };
    from_mode: AgentRuntimeMode;
    runtime_mode: AgentRuntimeMode;
    previous_generation: number;
    permission_generation: number;
    credential_id: string;
    ssh_account: {id:string;username:string;revision:number};
    capabilities?: string[];
    release?: {
      version?: string;
      build_id?: string;
      artifact_sha256?: string;
      sha256?: string;
      source_revision?: string;
    };
    steps?: string[];
    warnings?: string[];
  };
};
export type AgentRuntimeStatus = {
  machine_id: string;
  agent_id: string;
  runtime_mode: AgentRuntimeMode | null;
  permission_generation: number;
  observed_runtime: AgentRuntimeObservation | null;
  online: boolean;
  maintenance: AgentRuntimePlan | null;
};
export const agentRuntimePath = (machineID: string) =>
  `/machines/${encodeURIComponent(machineID)}/agent-runtime`;
export function runtimeObservation(
  value: unknown,
): AgentRuntimeObservation | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as Record<string, unknown>;
  if (
    !["root", "user"].includes(String(v.mode)) ||
    !Number.isSafeInteger(v.permission_generation) ||
    Number(v.permission_generation) < 1 ||
    !Number.isSafeInteger(v.uid) ||
    Number(v.uid) < 0 ||
    !Number.isSafeInteger(v.gid) ||
    Number(v.gid) < 0
  )
    return;
  if (Number(v.uid) === 0 || Number(v.gid) === 0)
    return;
  return v as AgentRuntimeObservation;
}
export function runtimePlanMatches(
  record: AgentRuntimePlan,
  machine: { id: string; agent_id?: string },
): boolean {
  const p = record?.plan;
  return (
    !!record?.id &&
    /^[a-f0-9]{64}$/.test(record.revision) &&
    [
      "awaiting_approval",
      "running",
      "verifying",
      "succeeded",
      "failed",
      "unknown",
      "cancelled",
    ].includes(record.status) &&
    !!p?.credential_id &&
    !!p.ssh_account?.id &&
    typeof p.ssh_account.username === "string" && !!p.ssh_account.username &&
    Number.isSafeInteger(p.ssh_account.revision) && p.ssh_account.revision >= 1 &&
    p.machine?.id === machine.id &&
    p.machine.agent_id === machine.agent_id &&
    ["root", "user"].includes(p.from_mode) &&
    ["root", "user"].includes(p.runtime_mode) &&
    p.from_mode !== p.runtime_mode &&
    Number.isSafeInteger(p.previous_generation) &&
    p.previous_generation >= 1 &&
    p.permission_generation === p.previous_generation + 1
  );
}
export const runtimePlanActive = (status: string) =>
  ["awaiting_approval", "running", "verifying", "unknown"].includes(status);
export const runtimePlanPending = (status: string) =>
  ["running", "verifying", "unknown"].includes(status);
export const runtimePlanCanonical = (value: unknown): string =>
  Array.isArray(value)
    ? "[" + value.map(runtimePlanCanonical).join(",") + "]"
    : value && typeof value === "object"
      ? "{" +
        Object.keys(value)
          .sort()
          .map(
            (key) =>
              JSON.stringify(key) +
              ":" +
              runtimePlanCanonical((value as Record<string, unknown>)[key]),
          )
          .join(",") +
        "}"
      : JSON.stringify(value);
export const runtimePlanExpired = (
  record: AgentRuntimePlan,
  now = Date.now(),
) =>
  !Number.isFinite(Date.parse(record.expires_at)) ||
  Date.parse(record.expires_at) <= now;

export const runtimeCapabilityText = (
  value: string,
  t: (zh: string, en: string) => string,
) =>
  value === "container.managed.v1"
    ? t("容器管理", "Container management")
    : value === "script.elevated.v1"
      ? t("root 脚本", "Root scripts")
      : value === "operations.managed.v1"
        ? t("受管主机运维", "Managed host operations")
        : value;
