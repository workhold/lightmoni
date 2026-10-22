# SDD 021：部署适配器契约

> 本文件是目标执行契约。当前 `SystemdDeploymentAdapter` 和 registry 只负责纯逻辑 `probe/plan/apply/verify/rollback` 与 typed action 校验，不调用远程主机。`service-deployments` 已接入管理员审批、Agent job 和最终健康回执状态映射，但通用部署计划尚未调用 systemd adapter 来生成 actions，因此默认计划仍会被安全拒绝。

适配器是中心的纯计划层。它不能调用 `child_process`、SSH、shell、systemctl、Docker CLI 或 Kubernetes API；这些动作由 Agent executor 在 capability allow-list 内解释。

## 接口

```ts
interface DeploymentAdapter<P extends string, Snapshot, Spec, Plan, Action> {
  readonly provider: P;
  probe(input: { target: Target<P>; snapshot: Snapshot; now?: Date }): ProbeResult<P>;
  plan(input: { id: string; spec: Spec; probe: ProbeResult<P>; now?: Date }): Plan;
  apply(plan: Plan, approved: boolean): ApplyResult<Action>;
  verify(plan: Plan, snapshot: Snapshot): VerificationResult<Snapshot>;
  rollback(plan: Plan): RollbackResult<Action>;
}
```

所有返回值必须是 JSON 可序列化对象，不包含原始命令、secret 或函数。`apply` 只把已批准 plan 转换为 actions；实际执行属于 Agent。

## 通用模型

```ts
type DeploymentState =
  | "draft" | "preflight" | "awaiting_approval" | "agent_ready"
  | "staging" | "activating" | "verifying" | "succeeded"
  | "failed" | "rollback_pending" | "rolling_back" | "rolled_back";

type HealthCheck =
  | {kind:"systemd-active"; unit:string}
  | {kind:"http"; url:string; timeoutMs?:number; expectedStatus?:number}
  | {kind:"tcp"; host:string; port:number; timeoutMs?:number};
```

## systemd MVP

`ServiceTarget`：

```ts
{
  id: string;
  provider: "systemd";
  unit: string;                 // 必须符合受限 .service 名
  releaseDirectory: string;    // 绝对路径，不含 ..，由中心登记
  machineId: string;
  agentId: string;
}
```

`SystemdSnapshot`：`available`、`unitExists`、`activeState`、`enabled`、`currentVersion?`、`currentArtifact?`。坏快照、unit 不存在、systemd 不可用或目标不匹配必须让 `probe.ready=false`。

允许的 `DeploymentAction`：

```ts
| {kind:"stage_artifact"; release_id:string; service_id:string; version:string; architecture:"any"|"linux-amd64"|"linux-arm64"; destination:string; sha256:string; size:number}
| {kind:"activate_release"; releaseDirectory:string; version:string; expectedCurrentVersion:string}
| {kind:"systemd"; operation:"daemon-reload"|"enable"|"disable"|"start"|"restart"|"stop"; unit:string}
| {kind:"health_check"; check:HealthCheck}
```

Agent 必须验证：action 的 unit 等于已登记 target.unit；stage destination 位于 releaseDirectory 下；artifact_id、service_id、version、架构、size 与该 job 的 release 一致；下载包 digest 与 action 匹配；`activate_release.releaseDirectory` 等于已登记目录且 version 来自已批准 release；`expectedCurrentVersion` 与目标 `current` 指针仍一致；健康检查 URL/host/port 通过 provider 校验。任何额外 action 或字段都拒绝。

`stage_artifact` 不含中心文件系统路径、任意 URL 或 bearer token。Agent 通过当前 job 专用下载端点取得内容，中心以 Agent control credential + job lease + action 中的 release/digest 三重绑定授权。MVP bundle 是 `lightmoni-release-v1.tar.gz`：严格 USTAR gzip，根有 `manifest.json` 与可执行 `run`；只允许普通文件和目录，拒绝 links/devices/extensions、路径逃逸、重复项和超限输入。Agent 在 SHA-256 通过后才解包。

systemd target 的管理员预置 unit 必须执行稳定入口 `<releaseDirectory>/current/run`。Agent 不编辑 unit；`current` 是相对链接 `releases/<version>`，以相同父目录的临时 symlink + 原子 rename 切换。普通文本 `current` 不符合新激活契约。

MVP 的受管 release 根目录由 root 创建，属主为 root，组为 `lightmoni-agent`（例如 `root:lightmoni-agent`、`0775`）；业务服务用户可读/遍历但不得加入 Agent 组或获得写权限。Agent 的 systemd 沙箱需将精确 release 根目录加入 `ReadWritePaths`。bundle 仅包含运行所需文件，任何密钥、环境凭据和私钥都必须通过独立秘密管理传递，不得放入版本包。

## 错误码

固定错误码包括：`provider_unsupported`、`invalid_target`、`invalid_artifact`、`snapshot_missing`、`systemd_unavailable`、`unit_missing`、`unit_inactive`、`artifact_conflict`、`health_check_failed`、`agent_not_ready`、`job_expired`、`capability_denied`、`digest_mismatch`、`unknown_execution_result`。

## 状态规则

- 计划只能从 `draft/preflight` 到 `awaiting_approval`；未批准计划不能进入 `staging`。
- Agent 激活前不能进入 `agent_ready` 之后阶段。
- `activating`/`verifying` 失败只能进入 `failed` 或 `rollback_pending`，不能直接标记成功。
- Agent 的 `succeeded` 回执必须来自 `verifying` 阶段并包含健康检查通过证据；缺失证据或执行中断时保留最后已知状态，并在 receipt 中标记 `unknown`。
- `rollback_pending → rolling_back → rolled_back`；回滚失败保留 `failed`、回执和人工处理提示。
- 成功的 release 不可原地修改；再次部署必须引用新的 version/digest。
