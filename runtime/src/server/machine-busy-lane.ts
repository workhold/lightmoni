export type BusyLaneEntry = { holder: string; since: number };
export type BusyLane = Map<string, BusyLaneEntry>;

export const holdBusy = (lane: BusyLane, machineID: string, holder: string, at: number) => {
  lane.set(machineID, { holder, since: at });
};

const labels: Record<string, string> = {
  terminal: "终端",
  "ssh-check": "SSH 检查",
  installation: "安装检查",
  deployment: "部署",
  "agent-update": "Agent 维护",
  "agent-runtime": "Agent 运行时",
  uninstallation: "卸载",
  docker: "Docker 安装",
  "state-recovery": "状态恢复",
  "installation-recovery": "安装核对",
};

export const busyLaneLabel = (holder: string) => labels[holder] ?? holder;
